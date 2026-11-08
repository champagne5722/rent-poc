import { describe, expect, it } from 'vitest';
import { deriveAttention, deriveOverview } from './owner-overview';
import { createFakeOverviewSource, todayInTaipei } from './owner-overview-source';
import { SEED_OWNERS } from './owner-session';

// 台北 2026-11-08 09:00
const NOW = new Date('2026-11-08T01:00:00Z');
const source = createFakeOverviewSource(() => NOW);

describe('todayInTaipei', () => {
  it.each([
    ['2026-11-07T15:59:59Z', '2026-11-07'],
    ['2026-11-07T16:00:00Z', '2026-11-08'],
  ])('%s 是台北的 %s', (iso, expected) => {
    expect(todayInTaipei(new Date(iso))).toBe(expected);
  });
});

describe('假資料 adapter', () => {
  it('第一位 seed 屋主涵蓋 MIL-96 要求的情境', async () => {
    const facts = await source.load(SEED_OWNERS[0]);
    const { rows, summary } = deriveOverview(facts, '2026-11-08');

    expect(new Set(rows.map((r) => r.businessType))).toEqual(new Set(['self_managed', 'managed', 'master_lease']));
    expect(new Set(rows.flatMap((r) => (r.manager?.legalTitle === '租賃住宅代管業者' ? [r.manager.id] : []))).size).toBe(2);
    expect(rows.map((r) => r.leaseState)).toEqual(expect.arrayContaining(['vacant', 'signing', 'settling', 'active']));
    expect(summary.revokedManagers).toHaveLength(1);
    expect(summary.asOf).toBe(NOW.toISOString());

    const kinds = new Set(deriveAttention(rows, '2026-11-08').map((a) => a.kind));
    expect(kinds).toEqual(
      new Set([
        'overdue',
        'authority_problem',
        'collected_funds_overdue',
        'deposit_settlement',
        'authority_pending',
        'lease_expiring',
      ]),
    );
  });

  it('第二位 seed 屋主沒有任何租賃單位', async () => {
    const facts = await source.load(SEED_OWNERS[1]);
    expect(deriveOverview(facts, '2026-11-08').rows).toEqual([]);
  });
});
