// buildSignerSequence（ADR-0018 決議 15）：由 `routeSignatures` 排出的席位與各席位的簽署人，組出交給簽署模組的簽署序列。
// 純函式，沒有 I/O。同一人兼任的合併屬 MIL-76，目前每個席位各是一位簽署人。

import type { Signer } from '../signing-module/provider';
import type { SignatureField } from '../types';
import type { SignaturePlan } from './types';

/** 一個席位的簽署人。執業人員的 email 必須取自其帳號，由呼叫端保證（ADR-0018 決議 10 第 6 項）。 */
export interface SeatAssignee {
  name: string;
  email: string;
}

export type BuildSignerSequenceResult = { ok: true; signers: Signer[] } | { ok: false; missing: string[] };

/**
 * @param assignees 以席位的 rule_id 為鍵。
 * @param signatureFields 合約上的簽署區域。有 slot 的歸該席位，沒有 slot 的歸同角色的第一個席位。
 * 有席位沒有簽署人時回傳缺少的 rule_id，不補預設值。
 */
export function buildSignerSequence(
  plan: SignaturePlan,
  assignees: Readonly<Record<string, SeatAssignee | undefined>>,
  signatureFields: readonly SignatureField[],
): BuildSignerSequenceResult {
  const missing = plan.seats.filter((seat) => !assignees[seat.ruleId]).map((seat) => seat.ruleId);
  if (missing.length > 0) return { ok: false, missing };

  const firstSeatOfRole = new Map<string, string>();
  for (const seat of plan.seats) if (!firstSeatOfRole.has(seat.role)) firstSeatOfRole.set(seat.role, seat.ruleId);

  const signers = plan.seats.map((seat): Signer => {
    const { name, email } = assignees[seat.ruleId]!;
    return {
      role: seat.role,
      name,
      email,
      verifyMethods: [...seat.verifyMethods],
      signatureFields: signatureFields.filter(
        (f) => f.signer === seat.role && (f.slot ?? firstSeatOfRole.get(f.signer)) === seat.ruleId,
      ),
    };
  });
  return { ok: true, signers };
}
