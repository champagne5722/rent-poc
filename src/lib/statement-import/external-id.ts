// 去重鍵 external_id（ADR-0014 決議 7）。

import { createHash } from 'node:crypto';
import { isRealIsoDate } from './dates';
import type { StatementRow } from './types';

/**
 * 對帳檔一列的 external_id。
 * 有交易序號時直接用序號（ADR-0014 決議 7 的字面）。注意去重鍵 `UNIQUE (org_id, source, external_id)`
 * 不含收款帳戶，不同帳戶的序號相同時會被誤判重複。這點留給資料層票決定是否加帳戶前綴。
 * 沒有交易序號時，用收款帳戶、入帳日、金額、摘要、當日同值序號算 SHA-256（十六進位小寫）。
 */
export function externalIdFor(row: StatementRow, accountId: string): string {
  const serial = row.transactionSerial?.trim();
  if (serial) return serial;
  if (accountId === '') throw new RangeError('收款帳戶 ID 不得為空');
  if (!isRealIsoDate(row.transactionDate)) throw new RangeError(`入帳日必須是 YYYY-MM-DD：${row.transactionDate}`);
  if (!Number.isSafeInteger(row.depositAmount) || row.depositAmount <= 0) {
    throw new RangeError(`金額必須是正整數元：${row.depositAmount}`);
  }
  if (!Number.isSafeInteger(row.sameDaySeq) || row.sameDaySeq < 1) {
    throw new RangeError(`當日同值序號必須是 1 以上的整數：${row.sameDaySeq}`);
  }
  const material = JSON.stringify([accountId, row.transactionDate, row.depositAmount, row.summary, row.sameDaySeq]);
  return createHash('sha256').update(material, 'utf8').digest('hex');
}
