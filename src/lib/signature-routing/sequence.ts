// buildSignerSequence（ADR-0018 決議 9、15）：由 `routeSignatures` 排出的席位與各席位的簽署人，組出交給簽署模組的簽署序列。
// 純函式，沒有 I/O。同一人兼任時合併成一位簽署人（MIL-76）。

import type { Signer } from '../signing-module/provider';
import type { ContractPartyRole, SignatureField } from '../types';
import type { PlannedSeat, SignaturePlan } from './types';

/**
 * 簽署人是誰。`partyId` 是自然人的 ID，`entityId` 是簽署人所屬的執業主體。
 * 同一個人以當事人簽署人與執業人員兩種身分出現時，兩邊的 `partyId` 相同。
 */
export interface SeatIdentity {
  partyId: string;
  entityId: string;
}

/** 一個席位的簽署人。執業人員的 email 必須取自其帳號，由呼叫端保證（ADR-0018 決議 10 第 6 項）。 */
export interface SeatAssignee {
  name: string;
  email: string;
  /** 合併的判定依據。沒有帶的席位不參與合併。 */
  identity?: SeatIdentity;
}

/** 一組合併：執業人員席位吸收它的當事人席位。合併後這位簽署人的主要角色是 `practitioner`。 */
export interface MergedSeats {
  practitionerRuleId: string;
  partyRuleId: string;
  /** 兼任的角色，也就是被吸收的當事人席位的角色。 */
  partyRole: ContractPartyRole;
}

export type BuildSignerSequenceResult = { ok: true; signers: Signer[] } | { ok: false; missing: string[] };

function entityPartyRole(seat: PlannedSeat): ContractPartyRole | null {
  const source = seat.practitioner?.entitySource;
  return source === 'party_a' || source === 'party_b' ? source : null;
}

/**
 * 找出要合併的席位（ADR-0018 決議 9）。判定條件：
 * 1. 執業人員席位的執業主體是甲方或乙方，也就是有對應的當事人席位。
 * 2. 當事人簽署人與執業人員的 `partyId` 相同。
 * 3. 當事人簽署人屬於同一個執業主體。
 * 經紀人席位的執業主體不是合約當事人，不合併。
 *
 * @param identities 以席位的 rule_id 為鍵。缺少身分資料的席位不合併。
 */
export function findMergedSeats(
  plan: Pick<SignaturePlan, 'seats'>,
  identities: Readonly<Record<string, SeatIdentity | undefined>>,
): MergedSeats[] {
  const merged: MergedSeats[] = [];
  for (const seat of plan.seats) {
    const partyRole = entityPartyRole(seat);
    if (!partyRole) continue;
    const partySeat = plan.seats.find((s) => s.role === partyRole);
    const practitioner = identities[seat.ruleId];
    const party = partySeat && identities[partySeat.ruleId];
    if (!partySeat || !practitioner || !party) continue;
    if (practitioner.partyId === party.partyId && practitioner.entityId === party.entityId) {
      merged.push({ practitionerRuleId: seat.ruleId, partyRuleId: partySeat.ruleId, partyRole });
    }
  }
  return merged;
}

/**
 * 每個席位的簽署人在簽署序列中的位置（從 0 起算）。
 * 兼任的當事人席位與執業人員席位指向同一個位置，其後的席位往前補。
 * 簽章紀錄的 `signerIndex` 用它，這樣紀錄參照的是合併後的簽署人（MIL-70）。
 */
export function seatSignerIndexes(plan: Pick<SignaturePlan, 'seats'>, merged: readonly MergedSeats[]): Record<string, number> {
  const absorbed = new Set(merged.map((m) => m.partyRuleId));
  const indexes: Record<string, number> = {};
  let next = 0;
  for (const seat of plan.seats) {
    if (absorbed.has(seat.ruleId)) continue;
    indexes[seat.ruleId] = next;
    next += 1;
  }
  for (const m of merged) indexes[m.partyRuleId] = indexes[m.practitionerRuleId];
  return indexes;
}

/** 歸屬某個席位的簽署區域：有 slot 的歸該席位，沒有 slot 的歸同角色的第一個席位。 */
export function fieldsOfSeat(
  plan: Pick<SignaturePlan, 'seats'>,
  ruleId: string,
  signatureFields: readonly SignatureField[],
): SignatureField[] {
  const seat = plan.seats.find((s) => s.ruleId === ruleId);
  if (!seat) return [];
  const firstOfRole = plan.seats.find((s) => s.role === seat.role)?.ruleId;
  return signatureFields.filter((f) => f.signer === seat.role && (f.slot ?? firstOfRole) === ruleId);
}

/**
 * @param assignees 以席位的 rule_id 為鍵。
 * @param signatureFields 合約上的簽署區域。有 slot 的歸該席位，沒有 slot 的歸同角色的第一個席位。
 * 有席位沒有簽署人時回傳缺少的 rule_id，不補預設值。
 *
 * 兩個席位是同一人時合併成一位簽署人：排在執業人員的位置，主要角色是 `practitioner`，
 * 兼任角色放 `concurrentRoles`，email 取自執業人員，兩個席位的簽署區域都歸這位簽署人。
 */
export function buildSignerSequence(
  plan: SignaturePlan,
  assignees: Readonly<Record<string, SeatAssignee | undefined>>,
  signatureFields: readonly SignatureField[],
): BuildSignerSequenceResult {
  const missing = plan.seats.filter((seat) => !assignees[seat.ruleId]).map((seat) => seat.ruleId);
  if (missing.length > 0) return { ok: false, missing };

  const identities = Object.fromEntries(plan.seats.map((seat) => [seat.ruleId, assignees[seat.ruleId]!.identity]));
  const merged = findMergedSeats(plan, identities);
  const absorbed = new Set(merged.map((m) => m.partyRuleId));

  const signers = plan.seats
    .filter((seat) => !absorbed.has(seat.ruleId))
    .map((seat): Signer => {
      const { name, email } = assignees[seat.ruleId]!;
      const concurrent = merged.filter((m) => m.practitionerRuleId === seat.ruleId);
      const seatRuleIds = new Set([seat.ruleId, ...concurrent.map((m) => m.partyRuleId)]);
      const owned = new Set(
        [...seatRuleIds].flatMap((ruleId) => fieldsOfSeat(plan, ruleId, signatureFields)),
      );
      return {
        role: seat.role,
        name,
        email,
        ...(concurrent.length > 0 ? { concurrentRoles: concurrent.map((m) => m.partyRole) } : {}),
        verifyMethods: [...seat.verifyMethods],
        signatureFields: signatureFields.filter((f) => owned.has(f)),
      };
    });
  return { ok: true, signers };
}
