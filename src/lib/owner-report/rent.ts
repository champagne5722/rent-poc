// 租金區段：本月應收、已入帳、月底累計逾期、預收餘額。
// 逾期是月底累計未足額。已入帳是配置到本月期別的金額（MIL-47）。

import { prepaidRentAccount } from '../ledger';
import { allocatedAmount, isOverdue, outstandingAmount, toTaipeiDate, type Allocation } from '../receivables';
import type { ReportContext } from './context';
import { compareText } from './dates';
import type { OverduePeriod, RentRow, ReportAllocation } from './types';

/** 還原月底當時的配置：月底後才寫入的不計，月底後才失效的仍算有效。 */
function allocationsAsOfMonthEnd(ctx: ReportContext): Allocation[] {
  const end = ctx.bounds.end;
  return ctx.input.allocations.map((a: ReportAllocation) => {
    const written = toTaipeiDate(a.postedAt) <= end;
    const stillValid = a.deactivatedAt === null ? a.active : toTaipeiDate(a.deactivatedAt) > end;
    return {
      id: a.id,
      sourceId: a.sourceId,
      periodId: a.periodId,
      amount: a.amount,
      source: a.source,
      kind: a.kind,
      active: written && stillValid,
    };
  });
}

export function buildRent(ctx: ReportContext): RentRow[] {
  const allocations = allocationsAsOfMonthEnd(ctx);

  return ctx.units.map((unit) => {
    const periods = ctx.input.periods.filter((p) => p.caseId === unit.caseId && p.state !== 'cancelled');
    const monthPeriods = periods.filter((p) => p.periodKey === ctx.bounds.month);

    const overduePeriods: OverduePeriod[] = periods
      .filter((p) => isOverdue(p, allocations, ctx.options.graceDays, ctx.bounds.end))
      .sort((a, b) => compareText([a.dueDate, b.dueDate], [a.periodKey, b.periodKey]))
      .map((p) => ({ periodKey: p.periodKey, dueDate: p.dueDate, outstanding: outstandingAmount(p, allocations) }));

    return {
      unitId: unit.unitId,
      address: unit.address,
      dueDate: monthPeriods.length > 0 ? monthPeriods[0].dueDate : null,
      rentDue: monthPeriods.reduce((sum, p) => sum + p.amount, 0),
      received: monthPeriods.reduce((sum, p) => sum + allocatedAmount(p, allocations), 0),
      overdue: overduePeriods.reduce((sum, p) => sum + p.outstanding, 0),
      overduePeriods,
      prepaidBalance: ctx.balanceOf(unit.caseId, prepaidRentAccount(unit.caseId)),
    };
  });
}
