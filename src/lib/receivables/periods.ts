// 應收期別切分與提前終止（ADR-0015 決議 11、ADR-0050 決議 5）。純函式，沒有 I/O。

import { assertMoney, daysInMonth, diffDays, formatDate, parseDate } from './dates';
import type { PeriodContract, PeriodDraft, ReceivablePeriod } from './types';

/** 月租乘日數除以該月日數，四捨五入到元（半數進位）。全程整數運算，避免浮點誤差。 */
function prorate(monthlyRent: number, days: number, monthDays: number): number {
  if (days === monthDays) return monthlyRent;
  return Math.floor((2 * monthlyRent * days + monthDays) / (2 * monthDays));
}

/**
 * 依租期切出應收期別。一個月一期，期別是日曆月與租期重疊的部分。
 * 到期日是該月付款日，該月沒有那天時取月底。首期的到期日取付款日與期別起日較晚者，
 * 避免建立當天就逾期。首末期不足一個月時依日數比例計算。
 * 輸入不合法時丟 RangeError。
 */
export function splitPeriods(contract: PeriodContract): PeriodDraft[] {
  const { startDate, endDate, paymentDay, monthlyRent } = contract;
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  if (diffDays(endDate, startDate) < 0) throw new RangeError(`租期迄日早於起日：${startDate} 到 ${endDate}`);
  if (!Number.isInteger(paymentDay) || paymentDay < 1 || paymentDay > 31) {
    throw new RangeError(`付款日必須是 1 到 31 的整數：${paymentDay}`);
  }
  assertMoney(monthlyRent, '月租');
  if (!Number.isSafeInteger(2 * monthlyRent * 31)) throw new RangeError(`月租過大，按比例計算會超出安全整數：${monthlyRent}`);

  const drafts: PeriodDraft[] = [];
  let year = start.year;
  let month = start.month;
  while (year < end.year || (year === end.year && month <= end.month)) {
    const monthDays = daysInMonth(year, month);
    const firstDay = year === start.year && month === start.month ? start.day : 1;
    const lastDay = year === end.year && month === end.month ? end.day : monthDays;
    const periodStart = formatDate(year, month, firstDay);
    const periodEnd = formatDate(year, month, lastDay);
    const payDate = formatDate(year, month, Math.min(paymentDay, monthDays));
    drafts.push({
      periodKey: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`,
      periodStart,
      periodEnd,
      dueDate: payDate < periodStart ? periodStart : payDate,
      amount: prorate(monthlyRent, lastDay - firstDay + 1, monthDays),
      kind: 'rent',
    });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return drafts;
}

/**
 * 提前終止：期別起日晚於終止日的期別改 cancelled。
 * 終止日所在的期別不調整金額，也不取消（ADR-0050 決議 5）。回傳新陣列，不改動輸入。
 */
export function cancelPeriodsAfter(
  periods: readonly ReceivablePeriod[],
  terminationDate: string,
): ReceivablePeriod[] {
  parseDate(terminationDate);
  return periods.map((p) =>
    p.state === 'active' && diffDays(p.periodStart, terminationDate) > 0 ? { ...p, state: 'cancelled' } : p,
  );
}
