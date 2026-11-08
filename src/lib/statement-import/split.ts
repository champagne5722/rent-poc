// 待配對清單「拆給多個案件」的金額檢查（ADR-0050 決議 8、MIL-132）。

import type { SplitPart, SplitResult } from './types';

/**
 * 檢查拆分：每筆金額必須是正整數元，同一案件同一用途不得出現兩次，合計必須等於該列金額。
 * 該列金額不是正整數元時丟 RangeError（它來自解析結果，不是使用者輸入）。
 */
export function validateSplit(rowAmount: number, parts: readonly SplitPart[]): SplitResult {
  if (!Number.isSafeInteger(rowAmount) || rowAmount <= 0) {
    throw new RangeError(`該列金額必須是正整數元：${rowAmount}`);
  }
  if (parts.length === 0) return { ok: false, reason: 'no_parts', expected: rowAmount, actual: 0 };

  const actual = parts.reduce((sum, p) => sum + (Number.isFinite(p.amount) ? p.amount : 0), 0);
  if (parts.some((p) => !Number.isSafeInteger(p.amount) || p.amount <= 0)) {
    return { ok: false, reason: 'invalid_part_amount', expected: rowAmount, actual };
  }
  const keys = new Set(parts.map((p) => JSON.stringify([p.caseId, p.purpose])));
  if (keys.size !== parts.length) {
    return { ok: false, reason: 'duplicate_case_purpose', expected: rowAmount, actual };
  }
  if (actual !== rowAmount) return { ok: false, reason: 'sum_mismatch', expected: rowAmount, actual };
  return { ok: true };
}
