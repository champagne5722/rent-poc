// 申請（委託管理申請、住宅包租申請）的狀態與期限（MIL-206，ADR-0029、ADR-0030）。純函式，沒有 I/O。
// 時間一律由參數傳入，期限在讀取時判定，不依賴計時器。
//
// 狀態表（MIL-193 spec）：
//   待屋主確認  業者產生連結。屋主送出，或連結 7 天後失效。
//   待業者接受  屋主送出。業者接受、業者未接受、屋主收回，或送出後 7 天失效。
//   已接受      業者接受並指派管理人員。合約完成、任一方結束，或 30 天沒送合約後失效。
//   已完成      合約全員完成。
// 本票（MIL-206）只接線「送出」與「收回」。接受、未接受、結束、30 天失效屬 MIL-210，已完成屬 MIL-211 與 MIL-212。
// 這些轉移在這裡先定義好，下游票呼叫 applyTransition，不再改狀態表。
// 屋主的動作叫「收回」，接受之後的動作叫「結束」，不用「撤回」（GLOSSARY）。
//
// 業者看到的狀態就是 effectiveStatus 的結果。屋主還沒送出時，「沒人打開」「有人打開」「已綁定但沒送出」
// 三種情況在業者端都是待屋主確認，資料庫的函式不回傳綁定與否，這裡也沒有對應的欄位。

import { MANDATE_REQUEST_KINDS, type MandateRequestKind, type MandateRequestStatus } from '../types';

export { MANDATE_REQUEST_KINDS };
export type { MandateRequestKind, MandateRequestStatus };

/** 申請對應的業別（registry.practice_licenses.kind）。委託管理申請對代管業，住宅包租申請對包租業。 */
export const LICENSE_KIND_OF: Readonly<Record<MandateRequestKind, 'management' | 'master_lease'>> = {
  management: 'management',
  master_lease: 'master_lease',
};

/** 資料庫存的狀態。 */
export const STORED_STATUSES = [
  'pending_owner',
  'pending_practice',
  'accepted',
  'declined',
  'withdrawn',
  'ended',
  'completed',
] as const;
export type StoredStatus = (typeof STORED_STATUSES)[number];

/** 連結 7 天失效，從建立起算。不論有沒有代填資料。與 migration 0086 的 registry.create_mandate_request 同值。 */
export const LINK_VALID_DAYS = 7;
/** 屋主送出後，業者 7 天內沒接受就失效。 */
export const SUBMITTED_VALID_DAYS = 7;
/** 業者接受後，30 天內沒送出合約就失效。 */
export const ACCEPTED_VALID_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

const addDays = (from: Date, days: number): Date => new Date(from.getTime() + days * DAY_MS);

/** 判定狀態所需的事實。時間欄位沒發生過的是 null。 */
export interface RequestFacts {
  status: StoredStatus;
  linkExpiresAt: Date;
  submittedAt: Date | null;
  acceptedAt: Date | null;
  /** 業者已對這份申請送出合約。送出後，接受後的 30 天期限不再適用。 */
  contractSentAt: Date | null;
}

/** 連結的失效時間。 */
export function linkExpiryFrom(createdAt: Date): Date {
  return addDays(createdAt, LINK_VALID_DAYS);
}

/**
 * 目前仍有效的期限。沒有期限的狀態（已完成、已收回、未接受、已結束）回 null。
 * 欄位不全（例如待業者接受卻沒有送出時間）也回 null。資料庫的檢查約束不讓這種列存在。
 */
export function deadlineOf(facts: RequestFacts): Date | null {
  switch (facts.status) {
    case 'pending_owner':
      return facts.linkExpiresAt;
    case 'pending_practice':
      return facts.submittedAt ? addDays(facts.submittedAt, SUBMITTED_VALID_DAYS) : null;
    case 'accepted':
      if (facts.contractSentAt !== null) return null;
      return facts.acceptedAt ? addDays(facts.acceptedAt, ACCEPTED_VALID_DAYS) : null;
    default:
      return null;
  }
}

/** 讀取時的狀態。期限的時間點（含）起算失效：now 等於期限時已失效。 */
export function effectiveStatus(facts: RequestFacts, now: Date): MandateRequestStatus {
  const deadline = deadlineOf(facts);
  if (deadline !== null && now.getTime() >= deadline.getTime()) return 'expired';
  return facts.status;
}

/** 申請在這個狀態佔用它的租賃單位：屋主不能把同一個租賃單位再交給另一份申請。 */
export function occupiesUnits(status: MandateRequestStatus): boolean {
  return status === 'pending_practice' || status === 'accepted';
}

export const TRANSITION_EVENTS = ['submit', 'withdraw', 'accept', 'decline', 'end', 'complete'] as const;
export type TransitionEvent = (typeof TRANSITION_EVENTS)[number];

interface TransitionRule {
  from: StoredStatus;
  to: StoredStatus;
  /** 誰觸發。 */
  by: 'owner' | 'practice' | 'system';
  /** 哪一張票接線。 */
  wiredBy: 'MIL-206' | 'MIL-210' | 'MIL-211' | 'MIL-212';
}

/** 完整的轉移表。 */
export const TRANSITIONS: Readonly<Record<TransitionEvent, TransitionRule>> = {
  submit: { from: 'pending_owner', to: 'pending_practice', by: 'owner', wiredBy: 'MIL-206' },
  withdraw: { from: 'pending_practice', to: 'withdrawn', by: 'owner', wiredBy: 'MIL-206' },
  accept: { from: 'pending_practice', to: 'accepted', by: 'practice', wiredBy: 'MIL-210' },
  decline: { from: 'pending_practice', to: 'declined', by: 'practice', wiredBy: 'MIL-210' },
  end: { from: 'accepted', to: 'ended', by: 'owner', wiredBy: 'MIL-210' },
  complete: { from: 'accepted', to: 'completed', by: 'system', wiredBy: 'MIL-211' },
};

export type TransitionResult = { ok: true; next: StoredStatus } | { ok: false; reason: 'expired' | 'wrong_status' };

/**
 * 在 now 這個時間點，事件能不能發生。失效的申請不能再轉移。
 * 「結束」在接受之後兩方都能做，這裡不檢查是誰觸發，由呼叫端的授權決定。
 */
export function applyTransition(facts: RequestFacts, event: TransitionEvent, now: Date): TransitionResult {
  const rule = TRANSITIONS[event];
  if (effectiveStatus(facts, now) === 'expired') return { ok: false, reason: 'expired' };
  if (facts.status !== rule.from) return { ok: false, reason: 'wrong_status' };
  return { ok: true, next: rule.to };
}
