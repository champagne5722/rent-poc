// 謄本送件表單與審核台判定表單的欄位規則（MIL-201，ADR-0026 決議 1、6、9）。純函式，沒有 I/O。
// 檔案本身（類型、大小）由 route 與 flows 檢查，這裡只驗證文字欄位。

import { EVIDENCE_MAX_BYTES } from '../practice-entities/rules';

/** 謄本檔案的限制。route 與 flows 用同一個上限（EVIDENCE_MAX_BYTES）檢查，畫面顯示同一組數字。 */
export const TRANSCRIPT_MAX_BYTES = EVIDENCE_MAX_BYTES;
export const TRANSCRIPT_MAX_MB = TRANSCRIPT_MAX_BYTES / 1024 / 1024;
/** 謄本只收 PDF、PNG、JPEG（以內容判斷）。副檔名給檔案選擇器的 accept 用。 */
export const TRANSCRIPT_ACCEPT = '.pdf,.png,.jpg,.jpeg';
export const TRANSCRIPT_FILE_RULE_TEXT = `格式是 PDF、PNG 或 JPG，一次一個檔案，不超過 ${TRANSCRIPT_MAX_MB} MB`;

export const CLAIMED_OWNER_MAX = 100;
export const TRUST_FIELD_MAX = 500;
export const HOLDER_MASKED_MAX = 40;
export const REASON_MAX = 500;

/** 謄本顯示信託登記時要補的四項資料（ADR-0026 決議 1，P0-08）。依畫面順序。 */
export const TRUST_FIELDS = ['registeredOwner', 'relatedParties', 'registrationStatus', 'leaseClause'] as const;
export type TrustField = (typeof TRUST_FIELDS)[number];

export const TRUST_FIELD_LABELS: Readonly<Record<TrustField, string>> = {
  registeredOwner: '登記所有權人',
  relatedParties: '信託關係人',
  registrationStatus: '信託登記狀態',
  leaseClause: '出租權限條款',
};

export type TrustData = Readonly<Record<TrustField, string>>;

export type TranscriptFormField = 'claimedOwner' | 'acquiredAt' | 'trust';

export interface TranscriptForm {
  /** 使用者主張的所有權人。 */
  claimedOwner: string;
  /** 謄本的取得時間。 */
  acquiredAt: Date;
  /** 謄本顯示信託登記時有值，否則是 null。 */
  trust: TrustData | null;
}

export type TranscriptFormResult =
  | { ok: true; value: TranscriptForm }
  | { ok: false; field: TranscriptFormField; message: string; missing?: TrustField[] };

export interface TranscriptFormInput {
  claimedOwner?: unknown;
  acquiredAt?: unknown;
  hasTrust?: unknown;
  trustRegisteredOwner?: unknown;
  trustRelatedParties?: unknown;
  trustRegistrationStatus?: unknown;
  trustLeaseClause?: unknown;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function truthy(value: unknown): boolean {
  return value === true || value === 'true' || value === '1' || value === 'on';
}

/** 日期（YYYY-MM-DD，視為臺北時間當天 00:00）或完整的 ISO 時間。無法解析回 null。 */
export function parseAcquiredAt(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (raw === '') return null;
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00+08:00`) : new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * 驗證謄本送件的文字欄位。取得時間不得晚於 now。
 * 謄本顯示信託登記（hasTrust）時，四項資料必須齊全；缺的項目放在 missing，狀態維持原樣（P0-08 AC3）。
 */
export function validateTranscriptForm(input: TranscriptFormInput, now: Date): TranscriptFormResult {
  const claimedOwner = text(input.claimedOwner);
  if (claimedOwner === '') return { ok: false, field: 'claimedOwner', message: '請填你主張的所有權人' };
  if (claimedOwner.length > CLAIMED_OWNER_MAX || CONTROL_CHARS.test(claimedOwner)) {
    return { ok: false, field: 'claimedOwner', message: `所有權人不得超過 ${CLAIMED_OWNER_MAX} 字，也不得含控制字元` };
  }

  const acquiredAt = parseAcquiredAt(input.acquiredAt);
  if (!acquiredAt) return { ok: false, field: 'acquiredAt', message: '請填謄本的取得時間' };
  if (acquiredAt.getTime() > now.getTime()) return { ok: false, field: 'acquiredAt', message: '謄本的取得時間不得晚於現在' };

  if (!truthy(input.hasTrust)) return { ok: true, value: { claimedOwner, acquiredAt, trust: null } };

  const raw: Record<TrustField, string> = {
    registeredOwner: text(input.trustRegisteredOwner),
    relatedParties: text(input.trustRelatedParties),
    registrationStatus: text(input.trustRegistrationStatus),
    leaseClause: text(input.trustLeaseClause),
  };
  const missing = TRUST_FIELDS.filter((f) => raw[f] === '');
  if (missing.length > 0) {
    return {
      ok: false,
      field: 'trust',
      message: `謄本顯示信託登記時，必須補上：${missing.map((f) => TRUST_FIELD_LABELS[f]).join('、')}`,
      missing,
    };
  }
  const tooLong = TRUST_FIELDS.find((f) => raw[f].length > TRUST_FIELD_MAX || CONTROL_CHARS.test(raw[f]));
  if (tooLong) {
    return { ok: false, field: 'trust', message: `${TRUST_FIELD_LABELS[tooLong]}不得超過 ${TRUST_FIELD_MAX} 字，也不得含控制字元` };
  }
  return { ok: true, value: { claimedOwner, acquiredAt, trust: raw } };
}

// ---------------------------------------------------------------------------
// 審核台判定表單

export type CheckFormField = 'keyMatch' | 'holderMatch' | 'holderMasked' | 'reason';

export interface CheckForm {
  keyMatch: boolean;
  holderMatch: boolean;
  /** 謄本上已遮罩的登記名義人，營運者照謄本原樣填。 */
  holderMasked: string;
  reason: string;
}

export type CheckFormResult = { ok: true; value: CheckForm } | { ok: false; field: CheckFormField; message: string };

// 身分證字號（1 個英文字母加 9 碼數字）與統一編號、長串數字都不是遮罩後的名義人
const ID_NUMBER_LIKE = /[A-Za-z][12]\d{8}|\d{6,}/;

/**
 * 驗證判定表單。兩項比對必須是布林值，不接受字串。
 * 登記名義人只收謄本上已遮罩的原樣文字：含身分證字號或長串數字的值直接拒絕，避免未遮罩的證號落進資料庫。
 */
export function validateCheckForm(input: { keyMatch?: unknown; holderMatch?: unknown; holderMasked?: unknown; reason?: unknown }): CheckFormResult {
  if (typeof input.keyMatch !== 'boolean') return { ok: false, field: 'keyMatch', message: '請判定建號是否與謄本相符' };
  if (typeof input.holderMatch !== 'boolean') return { ok: false, field: 'holderMatch', message: '請判定登記名義人是否與主張的所有權人相符' };

  const holderMasked = text(input.holderMasked);
  if (holderMasked === '') return { ok: false, field: 'holderMasked', message: '請照謄本填登記名義人（已遮罩）' };
  if (holderMasked.length > HOLDER_MASKED_MAX || CONTROL_CHARS.test(holderMasked)) {
    return { ok: false, field: 'holderMasked', message: `登記名義人不得超過 ${HOLDER_MASKED_MAX} 字，也不得含控制字元` };
  }
  if (ID_NUMBER_LIKE.test(holderMasked)) {
    return { ok: false, field: 'holderMasked', message: '登記名義人只填謄本上遮罩後的姓名，不得含證號' };
  }

  const reason = text(input.reason);
  if (reason === '') return { ok: false, field: 'reason', message: '請填判定理由' };
  if (reason.length > REASON_MAX) return { ok: false, field: 'reason', message: `判定理由不得超過 ${REASON_MAX} 字` };

  return { ok: true, value: { keyMatch: input.keyMatch, holderMatch: input.holderMatch, holderMasked, reason } };
}
