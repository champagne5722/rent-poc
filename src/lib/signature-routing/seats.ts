// 分流條件換成畫面用的簽署序列（MIL-67）。純函式，沒有 I/O，client 與 server 都能引用。
// 規則表與排序仍在 route.ts，這裡只負責把結果換成畫面要的席位資料與擋下原因。

import { BUSINESS_TYPE_LABELS, partyLabels, practitionerTitle, type ContractType, type PartyLabels } from '../labels';
import { signatureBlockLayout } from '../pdf-layout';
import { SIGNER_ROLE_LABELS, type ContractRoutingConditions, type SignerRole } from '../types';
import { routingFactsOf } from './facts';
import type { MergedSeats } from './sequence';
import { routeSignatures } from './route';
import type { SignaturePlan } from './types';

/** 簽署序列中的一個席位，畫面用。 */
export interface SeatView {
  /** 規則列的 rule_id，也是簽署區域 `slot` 的值。 */
  ruleId: string;
  role: SignerRole;
  /** 簡稱，用在按鈕與簽名框：甲方、乙方、執業人員（租賃住宅管理人員）。 */
  label: string;
  /** 完整稱謂，用在檢核與序列說明：甲方（出租人）、乙方（承租人）。 */
  fullLabel: string;
  /** 執業人員席位的法定稱謂，印在簽署欄。 */
  practitionerTitle?: string;
  /** 規則列要求這個席位在現況確認附件頁也有簽署區域（MIL-71）。沒有要求時省略。 */
  requiresStatusAnnex?: true;
}

export type RoutingEvaluation =
  | { ok: true; plan: SignaturePlan; seats: SeatView[] }
  | { ok: false; reason: string };

/** 兩方席位，稱謂依合約類型取字（MIL-74）。 */
export function partyOnlySeats(contractType: ContractType): readonly SeatView[] {
  const labels = partyLabels(contractType);
  return [
    { ruleId: 'party_a', role: 'party_a', label: SIGNER_ROLE_LABELS.party_a, fullLabel: labels.partyAFull },
    { ruleId: 'party_b', role: 'party_b', label: SIGNER_ROLE_LABELS.party_b, fullLabel: labels.partyBFull },
  ];
}

/**
 * 沒有可用簽署序列時（規則未定義、形狀不對）退回的兩方席位，與 N 列版面之前相同。
 * PDF 預覽用它，不讓分流條件有問題的草稿連預覽都開不了。這是租賃合約的稱謂。
 */
export const PARTY_ONLY_SEATS: readonly SeatView[] = partyOnlySeats('lease');

function seatView(seat: SignaturePlan['seats'][number], labels: PartyLabels): SeatView {
  if (seat.role === 'practitioner') {
    const title = seat.practitioner ? practitionerTitle(seat.practitioner.certificateKinds[0]) : undefined;
    const label = title ? `${SIGNER_ROLE_LABELS.practitioner}（${title}）` : SIGNER_ROLE_LABELS.practitioner;
    return {
      ruleId: seat.ruleId,
      role: seat.role,
      label,
      fullLabel: label,
      practitionerTitle: title,
      ...(seat.requiredFieldPages.includes('status_annex') ? { requiresStatusAnnex: true as const } : {}),
    };
  }
  return {
    ruleId: seat.ruleId,
    role: seat.role,
    label: SIGNER_ROLE_LABELS[seat.role],
    fullLabel: seat.role === 'party_a' ? labels.partyAFull : labels.partyBFull,
  };
}

function describeConditions(c: ContractRoutingConditions): string {
  const parts = [BUSINESS_TYPE_LABELS[c.businessType]];
  if (c.lesseeIsMasterLessor) parts.push('承租人是包租業者');
  if (c.brokerMediated) parts.push('有經紀業者居間');
  return parts.join('、');
}

/**
 * @param stored `fields.routing` 的原始值。undefined 視為自管租賃合約（沒有分流條件的既有合約）。
 * 規則表沒有定義的組合、形狀不對的值都回傳原因，不給預設序列。
 */
export function evaluateRouting(stored: unknown, contractType: ContractType = 'lease'): RoutingEvaluation {
  const resolved = routingFactsOf(contractType, stored);
  if (!resolved.ok) return { ok: false, reason: `${resolved.reason}，請重新選擇分流條件` };
  const route = routeSignatures(resolved.facts);
  if (route.kind === 'rejected') {
    const conditions =
      resolved.facts.documentType === 'lease'
        ? describeConditions(resolved.facts)
        : `委託管理合約、${BUSINESS_TYPE_LABELS[resolved.facts.businessType]}`;
    return { ok: false, reason: `規則表沒有定義「${conditions}」這個組合，請調整分流條件後再繼續` };
  }
  if (route.kind === 'not_required') return { ok: false, reason: '這個組合不送簽，由雙方確認' };
  const labels = partyLabels(contractType);
  return { ok: true, plan: route.plan, seats: route.plan.seats.map((seat) => seatView(seat, labels)) };
}

/**
 * 存草稿時檢查 `fields.routing` 的形狀。沒有帶（undefined）或形狀正確回 null。
 * 規則未定義的組合不在這裡擋，草稿可以先存，wizard 會擋下一步。
 */
export function routingInputError(stored: unknown, contractType: ContractType = 'lease'): string | null {
  const resolved = routingFactsOf(contractType, stored);
  return resolved.ok ? null : resolved.reason;
}

/**
 * 簽署序列換成印列順序：甲方、乙方、執業人員（ADR-0018 決議 14）。
 * PDF 簽署欄與編輯器的新增按鈕都用這個順序，排版細節在 `signatureBlockLayout`。
 */
export function printOrder(seats: readonly SeatView[]): SeatView[] {
  return signatureBlockLayout(seats.map((seat) => ({ role: seat.role, slot: seat.ruleId }))).map(
    (spot) => seats.find((seat) => seat.ruleId === spot.slot)!,
  );
}

/**
 * 合併後實際的簽署人，依簽署順序，一位簽署人一句。兼任的當事人席位併入執業人員，寫成「執業人員（…）兼甲方（出租人）」。
 * 確認頁用它列出簽署序列。沒有合併時與席位順序相同。
 */
export function signerChainLabels(
  seats: readonly SeatView[],
  merges: ReadonlyArray<Pick<MergedSeats, 'practitionerRuleId' | 'partyRuleId'>>,
): string[] {
  const absorbed = new Set(merges.map((m) => m.partyRuleId));
  return seats
    .filter((seat) => !absorbed.has(seat.ruleId))
    .map((seat) => {
      const concurrent = merges
        .filter((m) => m.practitionerRuleId === seat.ruleId)
        .map((m) => seats.find((s) => s.ruleId === m.partyRuleId)?.fullLabel)
        .filter((label): label is string => Boolean(label));
      return [seat.fullLabel, ...concurrent].join('兼');
    });
}

export function hasPractitionerSeat(seats: readonly SeatView[]): boolean {
  return seats.some((seat) => seat.role === 'practitioner');
}
