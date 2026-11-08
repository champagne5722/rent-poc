// 屋主月報表彙總。輸入帳務資料，輸出報表結構。純函式：不碰資料庫、不讀系統時鐘、不改輸入。
// 報表單位是屋主乘產出組織乘月份（MIL-47、ADR-0050 決議 14）。

import { buildAttention } from './attention';
import { createContext } from './context';
import { buildDeposit } from './deposit';
import { buildHandovers } from './handover';
import { IMMUTABLE_STATEMENT, OWNER_REPORT_NOTES } from './labels';
import { buildLedgerDetail } from './ledger-detail';
import { buildRepairs } from './repairs';
import { buildRent } from './rent';
import type { OwnerReport, OwnerReportInput, OwnerReportOptions } from './types';

/**
 * @param month `YYYY-MM`，依分錄 `posted_at` 的台灣日期切月。
 * 範圍只含 `options.ownerId` 在 `options.orgId` 下的單位。其他屋主與其他組織的資料即使混在輸入裡也不計入。
 */
export function buildOwnerReport(input: OwnerReportInput, month: string, options: OwnerReportOptions): OwnerReport {
  const ctx = createContext(input, month, options);

  const rent = buildRent(ctx);
  const deposit = buildDeposit(ctx);
  const repairs = buildRepairs(ctx);
  const handover = buildHandovers(ctx);
  const detail = buildLedgerDetail(ctx);

  return {
    header: {
      ownerId: options.ownerId,
      ownerName: options.ownerName,
      month: ctx.bounds.month,
      periodStart: ctx.bounds.start,
      periodEnd: ctx.bounds.end,
      orgId: options.orgId,
      producerName: options.producerName,
      producerLegalTitle: options.producerLegalTitle,
      reportId: options.reportId,
      generatedAt: options.generatedAt,
      immutableStatement: IMMUTABLE_STATEMENT,
    },
    summary: {
      rentDue: sum(rent.map((r) => r.rentDue)),
      received: sum(rent.map((r) => r.received)),
      overdue: sum(rent.map((r) => r.overdue)),
      prepaidBalance: sum(rent.map((r) => r.prepaidBalance)),
      depositBalance: sum(deposit.map((d) => d.balance)),
    },
    attention: buildAttention(rent, handover.rows),
    rent,
    deposit,
    repairs,
    handovers: handover.rows,
    ledgerDetail: detail.rows,
    sourceBreakdown: detail.sourceBreakdown,
    notes: OWNER_REPORT_NOTES.map((note) => ({ ...note })),
    pendingVarianceNotes: handover.pendingVarianceNotes,
  };
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  if (!Number.isSafeInteger(total)) throw new RangeError('彙總金額超過安全整數範圍');
  return total;
}
