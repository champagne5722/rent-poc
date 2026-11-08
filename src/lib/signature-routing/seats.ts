// 分流條件換成畫面用的簽署序列（MIL-67）。純函式，沒有 I/O，client 與 server 都能引用。
// 規則表與排序仍在 route.ts，這裡只負責把結果換成畫面要的席位資料與擋下原因。

import { BUSINESS_TYPE_LABELS, partyLabels, practitionerTitle } from '../labels';
import { signatureBlockLayout } from '../pdf-layout';
import { SIGNER_ROLE_LABELS, type ContractRoutingConditions, type SignerRole } from '../types';
import { routingFactsOf } from './facts';
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
}

export type RoutingEvaluation =
  | { ok: true; plan: SignaturePlan; seats: SeatView[] }
  | { ok: false; reason: string };

const LEASE_LABELS = partyLabels('lease');

function seatView(seat: SignaturePlan['seats'][number]): SeatView {
  if (seat.role === 'practitioner') {
    const title = seat.practitioner ? practitionerTitle(seat.practitioner.certificateKinds[0]) : undefined;
    const label = title ? `${SIGNER_ROLE_LABELS.practitioner}（${title}）` : SIGNER_ROLE_LABELS.practitioner;
    return { ruleId: seat.ruleId, role: seat.role, label, fullLabel: label, practitionerTitle: title };
  }
  return {
    ruleId: seat.ruleId,
    role: seat.role,
    label: SIGNER_ROLE_LABELS[seat.role],
    fullLabel: seat.role === 'party_a' ? LEASE_LABELS.partyAFull : LEASE_LABELS.partyBFull,
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
export function evaluateRouting(stored: unknown): RoutingEvaluation {
  const resolved = routingFactsOf('lease', stored);
  if (!resolved.ok) return { ok: false, reason: `${resolved.reason}，請重新選擇分流條件` };
  const route = routeSignatures(resolved.facts);
  if (route.kind === 'rejected') {
    const conditions = resolved.facts.documentType === 'lease' ? describeConditions(resolved.facts) : '';
    return { ok: false, reason: `規則表沒有定義「${conditions}」這個組合，請調整分流條件後再繼續` };
  }
  if (route.kind === 'not_required') return { ok: false, reason: '這個組合不送簽，由雙方確認' };
  return { ok: true, plan: route.plan, seats: route.plan.seats.map(seatView) };
}

/**
 * 存草稿時檢查 `fields.routing` 的形狀。沒有帶（undefined）或形狀正確回 null。
 * 規則未定義的組合不在這裡擋，草稿可以先存，wizard 會擋下一步。
 */
export function routingInputError(stored: unknown): string | null {
  const resolved = routingFactsOf('lease', stored);
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

export function hasPractitionerSeat(seats: readonly SeatView[]): boolean {
  return seats.some((seat) => seat.role === 'practitioner');
}
