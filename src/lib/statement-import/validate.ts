// 輸入檢查。輸入資料不合法一律丟 RangeError。

import { isRealIsoDate } from './dates';
import type { StatementRow } from './types';

export function assertPositiveAmount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label}必須是正整數元：${value}`);
}

export function assertNonNegativeAmount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label}必須是非負整數元：${value}`);
}

export function assertIsoDate(value: string, label: string): void {
  if (!isRealIsoDate(value)) throw new RangeError(`${label}必須是 YYYY-MM-DD：${value}`);
}

/** 標準列的入帳日與金額必須合法。 */
export function assertValidRow(row: StatementRow): void {
  assertIsoDate(row.transactionDate, '入帳日');
  assertPositiveAmount(row.depositAmount, '金額');
}
