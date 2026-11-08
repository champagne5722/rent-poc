// 由分錄加總各科目的借方與貸方。純函式，不看事件類型。
// 押金餘額、預收餘額都是這個加總的特例（ADR-0015 決議 6：餘額一律即時加總）。

import type { RawBalance } from './accounts';
import type { JournalLine } from './types';

/** 加總過程超過安全整數時丟錯，不回傳失真的數字。 */
export function accountTotals(journals: ReadonlyArray<{ readonly lines: readonly JournalLine[] }>): Map<string, RawBalance> {
  const totals = new Map<string, RawBalance>();
  for (const journal of journals) {
    for (const line of journal.lines) {
      const current = totals.get(line.account) ?? { debit: 0, credit: 0 };
      const next = { debit: current.debit + line.debit, credit: current.credit + line.credit };
      if (!Number.isSafeInteger(next.debit) || !Number.isSafeInteger(next.credit)) {
        throw new RangeError(`科目 ${line.account} 的合計超過安全整數範圍`);
      }
      totals.set(line.account, next);
    }
  }
  return totals;
}
