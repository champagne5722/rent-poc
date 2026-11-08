// 修繕區段。修繕費用只記錄，不進鏡像帳（P0-16）。
// 列出月底仍未完成的紀錄（含沒有費用的），以及本月完成或取消的紀錄。

import type { ReportContext } from './context';
import { compareText, inMonth } from './dates';
import type { RepairRow, RepairStatus } from './types';

export function buildRepairs(ctx: ReportContext): RepairRow[] {
  const end = ctx.bounds.end;
  const rows: RepairRow[] = [];

  const sorted = [...ctx.input.repairs].sort((a, b) =>
    compareText([a.reportedAt, b.reportedAt], [a.repairId, b.repairId]),
  );

  for (const r of sorted) {
    const unit = ctx.unitByCase.get(r.caseId);
    if (!unit || r.reportedAt > end) continue;

    const closed = r.closedAt !== null && r.closedAt <= end;
    if (closed && r.closedAt !== null && !inMonth(r.closedAt, ctx.bounds)) continue;

    // 月底後才結案的紀錄，月底當時還在處理。現況若是已完成或已取消，當時的狀態無從得知，一律顯示處理中。
    let status: RepairStatus = r.status;
    if (!closed && (r.status === 'completed' || r.status === 'cancelled')) status = 'in_progress';

    rows.push({
      repairId: r.repairId,
      unitId: unit.unitId,
      address: unit.address,
      description: r.description,
      status,
      reportedAt: r.reportedAt,
      closedAt: closed ? r.closedAt : null,
      cost: r.cost,
      payer: r.payer,
      handler: r.handler,
    });
  }
  return rows;
}
