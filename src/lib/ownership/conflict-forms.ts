// 衝突個案的表單欄位規則（MIL-208）。純函式，沒有 I/O。

import type {
  OwnershipConflictBasis,
  OwnershipConflictContactChannel,
  OwnershipConflictContactTarget,
  OwnershipConflictDecision,
} from '../types';

export const CONFLICT_REASON_MAX = 500;
export const CONTACT_OUTCOME_MAX = 500;

export const CONFLICT_DECISIONS: readonly OwnershipConflictDecision[] = ['later_prevails', 'later_rejected', 'coexist'];
export const CONFLICT_BASES: readonly OwnershipConflictBasis[] = ['key_mismatch', 'holder_mismatch', 'both_mismatch'];
export const CONTACT_TARGETS: readonly OwnershipConflictContactTarget[] = ['earlier', 'later'];
export const CONTACT_CHANNELS: readonly OwnershipConflictContactChannel[] = ['phone', 'email', 'other'];

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const oneOf = <T extends string>(allowed: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value);

export type ContactFormField = 'target' | 'channel' | 'outcome' | 'contactedAt';
export interface ContactForm {
  target: OwnershipConflictContactTarget;
  channel: OwnershipConflictContactChannel;
  outcome: string;
  /** 沒填時由資料庫取現在。 */
  contactedAt: Date | null;
}
export type ContactFormResult = { ok: true; value: ContactForm } | { ok: false; field: ContactFormField; message: string };

/** 驗證聯絡紀錄表單。時間不得晚於現在（資料庫也會檢查，這裡先擋）。 */
export function validateContactForm(
  input: { target?: unknown; channel?: unknown; outcome?: unknown; contactedAt?: unknown },
  now: Date,
): ContactFormResult {
  if (!oneOf(CONTACT_TARGETS, input.target)) return { ok: false, field: 'target', message: '請選擇聯絡的對象' };
  if (!oneOf(CONTACT_CHANNELS, input.channel)) return { ok: false, field: 'channel', message: '請選擇聯絡的管道' };
  const outcome = text(input.outcome);
  if (outcome === '') return { ok: false, field: 'outcome', message: '請填聯絡的結果' };
  if (outcome.length > CONTACT_OUTCOME_MAX || CONTROL_CHARS.test(outcome)) {
    return { ok: false, field: 'outcome', message: `聯絡的結果不得超過 ${CONTACT_OUTCOME_MAX} 字，也不得含控制字元` };
  }
  let contactedAt: Date | null = null;
  if (input.contactedAt !== undefined && input.contactedAt !== null && input.contactedAt !== '') {
    const parsed = typeof input.contactedAt === 'string' ? new Date(input.contactedAt) : null;
    if (!parsed || Number.isNaN(parsed.getTime())) return { ok: false, field: 'contactedAt', message: '聯絡時間的格式有誤' };
    if (parsed.getTime() > now.getTime()) return { ok: false, field: 'contactedAt', message: '聯絡時間不得晚於現在' };
    contactedAt = parsed;
  }
  return { ok: true, value: { target: input.target, channel: input.channel, outcome, contactedAt } };
}

export type ConflictDecisionField = 'decision' | 'reason' | 'basis';
export interface ConflictDecisionForm {
  decision: OwnershipConflictDecision;
  reason: string;
  /** 只有 later_rejected 有值。 */
  basis: OwnershipConflictBasis | null;
}
export type ConflictDecisionResult = { ok: true; value: ConflictDecisionForm } | { ok: false; field: ConflictDecisionField; message: string };

/** 驗證決定表單。後來的不成立必須填不符的項目，其他決定不得填。 */
export function validateConflictDecisionForm(input: { decision?: unknown; reason?: unknown; basis?: unknown }): ConflictDecisionResult {
  if (!oneOf(CONFLICT_DECISIONS, input.decision)) return { ok: false, field: 'decision', message: '請選擇三種決定之一' };
  const reason = text(input.reason);
  if (reason === '') return { ok: false, field: 'reason', message: '請填決定的理由' };
  if (reason.length > CONFLICT_REASON_MAX) return { ok: false, field: 'reason', message: `決定的理由不得超過 ${CONFLICT_REASON_MAX} 字` };
  const hasBasis = input.basis !== undefined && input.basis !== null && input.basis !== '';
  if (input.decision === 'later_rejected') {
    if (!oneOf(CONFLICT_BASES, input.basis)) return { ok: false, field: 'basis', message: '後來的不成立時，請選擇不符的項目' };
    return { ok: true, value: { decision: input.decision, reason, basis: input.basis } };
  }
  if (hasBasis) return { ok: false, field: 'basis', message: '只有後來的不成立需要填不符的項目' };
  return { ok: true, value: { decision: input.decision, reason, basis: null } };
}

/** 後來的不成立時，兩項比對的結果。走既有的驗證失敗訊息。 */
export function matchesOfBasis(basis: OwnershipConflictBasis): { keyMatch: boolean; holderMatch: boolean } {
  return { keyMatch: basis === 'holder_mismatch', holderMatch: basis === 'key_mismatch' };
}
