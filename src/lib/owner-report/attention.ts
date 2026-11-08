// 需要留意區段：由其他區段推導，不存表。
// 順序固定：逾期、押金未交付、代收交付逾期。同一類內依單位在輸入的順序，再依代收日。

import { FLAG_DEPOSIT_NOT_HANDED_OVER, FLAG_OVERDUE } from './labels';
import type { AttentionItem, HandoverRow, RentRow } from './types';

const FUND_LABEL = { rent: '租金', deposit: '押金' } as const;

export function buildAttention(rent: readonly RentRow[], handovers: readonly HandoverRow[]): AttentionItem[] {
  const items: AttentionItem[] = [];

  for (const row of rent) {
    if (row.overdue <= 0 || row.overduePeriods.length === 0) continue;
    items.push({
      kind: 'overdue',
      unitId: row.unitId,
      address: row.address,
      amount: row.overdue,
      date: row.overduePeriods[0].dueDate,
      flag: FLAG_OVERDUE,
      note: `累計 ${row.overduePeriods.length} 期未足額`,
      handoverId: null,
    });
  }

  const handoverNote = (h: HandoverRow, state: string) =>
    `代收${FUND_LABEL[h.fundKind]}，代收日 ${h.receivedAt}，${state}，已 ${h.elapsedDays} 日`;

  const unitOrder = new Map(rent.map((row, index) => [row.unitId, index] as const));
  const byUnit = (a: HandoverRow, b: HandoverRow) =>
    (unitOrder.get(a.unitId) ?? 0) - (unitOrder.get(b.unitId) ?? 0);

  for (const h of [...handovers].sort(byUnit)) {
    if (h.fundKind !== 'deposit' || h.handedOverAt !== null) continue;
    items.push({
      kind: 'deposit_not_handed_over',
      unitId: h.unitId,
      address: h.address,
      amount: h.amount,
      date: h.receivedAt,
      flag: h.flag ?? FLAG_DEPOSIT_NOT_HANDED_OVER,
      note: handoverNote(h, '尚未交付'),
      handoverId: h.handoverId,
    });
  }

  for (const h of [...handovers].sort(byUnit)) {
    if (h.flag === null) continue;
    if (h.fundKind === 'deposit' && h.handedOverAt === null) continue;
    items.push({
      kind: 'handover_delay',
      unitId: h.unitId,
      address: h.address,
      amount: h.amount,
      date: h.receivedAt,
      flag: h.flag,
      note: handoverNote(h, h.handedOverAt === null ? '尚未交付' : `交付日 ${h.handedOverAt}`),
      handoverId: h.handoverId,
    });
  }

  return items;
}
