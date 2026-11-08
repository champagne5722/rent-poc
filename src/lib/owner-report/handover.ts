// 代收代付與交付區段（ADR-0014 決議 14、ADR-0050 決議 14）。
// 代收的款項在交付前一直列著。交付日晚於月底的，月底當時算尚未交付。
// Phase 1 的代付沒有鏡像帳事件，這裡不列代付明細。

import { handoverDelayLabel } from '../receivables';
import type { ReportContext } from './context';
import { diffDays, inMonth } from './dates';
import { handoverFlag } from './labels';
import type { HandoverRow } from './types';

export interface HandoverResult {
  rows: HandoverRow[];
  pendingVarianceNotes: string[];
}

export function buildHandovers(ctx: ReportContext): HandoverResult {
  const end = ctx.bounds.end;
  const rows: HandoverRow[] = [];
  const pending: string[] = [];

  const sorted = [...ctx.input.handovers].sort((a, b) =>
    a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : a.handoverId < b.handoverId ? -1 : 1,
  );

  for (const h of sorted) {
    const unit = ctx.unitByCase.get(h.caseId);
    if (!unit || h.receivedAt > end) continue;

    const delivered = h.handedOverAt !== null && h.handedOverAt <= end;
    const deliveredInMonth = delivered && h.handedOverAt !== null && inMonth(h.handedOverAt, ctx.bounds);
    if (!(inMonth(h.receivedAt, ctx.bounds) || deliveredInMonth || !delivered)) continue;

    const handedOverAt = delivered ? h.handedOverAt : null;
    // 社宅代管案件的 5 日規定是代收租金的交付期限，押金只看約定日數。
    const label = handoverDelayLabel(
      unit.agreedHandoverDays,
      handedOverAt,
      h.receivedAt,
      unit.isSocialHousing && h.fundKind === 'rent',
      end,
    );
    const difference = delivered && h.handedOverAmount !== null ? h.amount - h.handedOverAmount : null;
    const note = ctx.options.varianceNotes?.[h.handoverId]?.trim();

    if (difference !== null && difference !== 0 && !note) pending.push(h.handoverId);

    rows.push({
      handoverId: h.handoverId,
      unitId: unit.unitId,
      address: unit.address,
      fundKind: h.fundKind,
      receivedAt: h.receivedAt,
      amount: h.amount,
      handedOverAt,
      handedOverAmount: delivered ? h.handedOverAmount : null,
      elapsedDays: diffDays(handedOverAt ?? end, h.receivedAt),
      agreedDays: unit.agreedHandoverDays,
      difference,
      differenceNote: note ? note : null,
      label,
      flag: label ? handoverFlag(label) : null,
    });
  }
  return { rows, pendingVarianceNotes: pending };
}
