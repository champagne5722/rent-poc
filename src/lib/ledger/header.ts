// 分錄標頭欄位的檢查：ID 與時間。時間由呼叫端傳入，這裡不讀系統時鐘。

import { isValidLedgerId } from './accounts';
import { ledgerError, type JournalHeader, type LedgerError } from './types';

// `Date.parse` 會把 2026-02-30 當成 3 月 2 日，所以日期與時間的範圍都自己檢查。
const POSTED_AT_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD`，且必須是日曆上存在的日子。 */
export function isValidEffectiveDate(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** 含時區的 ISO 8601 字串。日期必須存在，時 0 到 23，分與秒 0 到 59，時區偏移最多 ±23:59。 */
export function isValidPostedAt(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const match = POSTED_AT_PATTERN.exec(value);
  if (!match) return false;
  const [hour, minute, second] = [Number(match[2]), Number(match[3]), Number(match[4])];
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (match[5] !== undefined && (Number(match[5]) > 23 || Number(match[6]) > 59)) return false;
  return isValidEffectiveDate(match[1]);
}

const ID_LABELS: ReadonlyArray<readonly [keyof JournalHeader, string]> = [
  ['journalId', '分錄 ID'],
  ['orgId', '組織 ID'],
  ['caseId', '案件 ID'],
  ['eventId', '業務事件 ID'],
];

export function checkHeader(header: JournalHeader): LedgerError[] {
  const errors: LedgerError[] = [];
  for (const [key, label] of ID_LABELS) {
    if (!isValidLedgerId(header[key])) {
      errors.push(ledgerError('invalid_id', `${label}不合法`));
    }
  }
  if (!isValidPostedAt(header.postedAt)) {
    errors.push(ledgerError('invalid_date', '登錄時間必須是含時區的 ISO 8601 字串'));
  }
  if (!isValidEffectiveDate(header.effectiveDate)) {
    errors.push(ledgerError('invalid_date', '銀行日必須是存在的 YYYY-MM-DD 日期'));
  }
  return errors;
}
