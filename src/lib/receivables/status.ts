// 期別狀態與逾期判定（ADR-0015 決議 11、MIL-42 Q1）。純函式，時間由參數傳入。

import { diffDays } from './dates';
import type { Allocation, PeriodStatus, ReceivablePeriod } from './types';

/** 該期別所有有效配置的金額合計。失效的配置與其他期別的配置不計。 */
export function allocatedAmount(period: Pick<ReceivablePeriod, 'id'>, allocations: readonly Allocation[]): number {
  let total = 0;
  for (const a of allocations) {
    if (a.active && a.periodId === period.id) total += a.amount;
  }
  return total;
}

/** 該期別尚未足額的金額。已取消的期別為 0。不會是負數。 */
export function outstandingAmount(period: ReceivablePeriod, allocations: readonly Allocation[]): number {
  if (period.state === 'cancelled') return 0;
  return Math.max(0, period.amount - allocatedAmount(period, allocations));
}

/**
 * 未入帳、部分入帳、已入帳，只看有效配置。狀態由配置算出，不存。
 * 已取消的期別回傳 cancelled。
 */
export function periodStatus(period: ReceivablePeriod, allocations: readonly Allocation[]): PeriodStatus {
  if (period.state === 'cancelled') return 'cancelled';
  const allocated = allocatedAmount(period, allocations);
  if (allocated >= period.amount) return 'paid';
  return allocated === 0 ? 'unpaid' : 'partial';
}

/**
 * 逾期：今天晚於「到期日加寬限天數」，而且期別仍未足額。
 * 寬限最後一天不算逾期，寬限次日才算。已取消與已足額的期別不逾期。
 * `today` 是台灣日期 YYYY-MM-DD，由呼叫端傳入。
 */
export function isOverdue(
  period: ReceivablePeriod,
  allocations: readonly Allocation[],
  graceDays: number,
  today: string,
): boolean {
  if (!Number.isInteger(graceDays) || graceDays < 0) {
    throw new RangeError(`寬限天數必須是 0 以上的整數：${graceDays}`);
  }
  const daysAfterDue = diffDays(today, period.dueDate);
  const status = periodStatus(period, allocations);
  if (status === 'cancelled' || status === 'paid') return false;
  return daysAfterDue > graceDays;
}
