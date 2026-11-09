// 鏡像帳的共用型別（ADR-0015、ADR-0050）。只有型別，沒有 I/O。

/** 分錄的一列明細。金額是整數新台幣元，每列恰好一欄大於 0。 */
export interface JournalLine {
  account: string;
  debit: number;
  credit: number;
}

/** 分錄標頭：由呼叫端傳入的 ID 與時間。ID 一律是 string（ULID）。 */
export interface JournalHeader {
  journalId: string;
  orgId: string;
  /** 一筆分錄只屬於一個案件（ADR-0015 決議 4）。先存文字，不掛外鍵（ADR-0050 決議 2）。 */
  caseId: string;
  /** `business_event_id`。與事件類型、組織一起唯一。 */
  eventId: string;
  /** ISO 8601 時間字串。報表月份依此欄（ADR-0015 決議 4）。 */
  postedAt: string;
  /** 銀行日，`YYYY-MM-DD`。 */
  effectiveDate: string;
}

/** 分錄的共同欄位。 */
interface JournalBase extends JournalHeader {
  /** 事件類型是開放字串，由事件登錄決定有哪些（ADR-0050 決議 3）。 */
  eventType: string;
  lines: readonly JournalLine[];
}

/** 一般分錄。`reversesJournalId` 與 `reason` 必須是 null。 */
export interface OriginalJournal extends JournalBase {
  reversesJournalId: null;
  reason: null;
}

/** 沖銷分錄。型別上與一般分錄分開，所以不能當 `buildReversal` 的輸入（不得沖銷沖銷分錄）。 */
export interface ReversalJournal extends JournalBase {
  reversesJournalId: string;
  reason: string;
}

export type Journal = OriginalJournal | ReversalJournal;

export function isReversal(journal: Journal): journal is ReversalJournal {
  return journal.reversesJournalId !== null;
}

/** 錯誤碼。訊息是給人讀的繁體中文，程式比對用 code。 */
export const LEDGER_ERROR_CODES = [
  'too_few_lines',
  'invalid_lines',
  'invalid_account',
  'non_integer',
  'negative_amount',
  'unsafe_integer',
  'line_both_sides',
  'line_empty',
  'unbalanced',
  'invalid_id',
  'invalid_date',
  'unknown_event',
  'event_not_postable',
  'invalid_payload',
  'reason_required',
  'cannot_reverse_reversal',
  'original_invalid',
  // 以下四個由資料庫包裝（post.ts）回傳，純函式不會產生
  'duplicate_event',
  'journal_not_found',
  'already_reversed',
  'case_mismatch',
] as const;

export type LedgerErrorCode = (typeof LEDGER_ERROR_CODES)[number];

export interface LedgerError {
  code: LedgerErrorCode;
  message: string;
  /** 與明細列有關的錯誤才有，從 0 起算。 */
  lineIndex?: number;
}

export type LedgerResult<T> = { ok: true; value: T } | { ok: false; errors: LedgerError[] };

export function ledgerError(code: LedgerErrorCode, message: string, lineIndex?: number): LedgerError {
  return lineIndex === undefined ? { code, message } : { code, message, lineIndex };
}
