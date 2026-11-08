import { describe, expect, it } from 'vitest';
import { isOverdue, periodStatus } from './status';
import type { Allocation, ReceivablePeriod } from './types';

const PERIOD: ReceivablePeriod = {
  id: 'p-2026-03',
  periodKey: '2026-03',
  periodStart: '2026-03-01',
  periodEnd: '2026-03-31',
  dueDate: '2026-03-05',
  amount: 20000,
  kind: 'rent',
  state: 'active',
};

let seq = 0;
function alloc(over: Partial<Allocation>): Allocation {
  seq += 1;
  return {
    id: `a${seq}`,
    sourceId: 'r1',
    periodId: PERIOD.id,
    amount: 0,
    source: 'receipt',
    kind: 'rent',
    active: true,
    ...over,
  };
}

describe('periodStatus（只看有效配置）', () => {
  it.each([
    ['沒有配置', [], 'unpaid'],
    ['配置 0 元', [{ amount: 0 }], 'unpaid'],
    ['配置 1 元', [{ amount: 1 }], 'partial'],
    ['差 1 元足額', [{ amount: 19999 }], 'partial'],
    ['剛好足額', [{ amount: 20000 }], 'paid'],
    ['兩筆合計足額', [{ amount: 12000 }, { amount: 8000 }], 'paid'],
    ['兩筆合計不足', [{ amount: 12000 }, { amount: 7000 }], 'partial'],
    ['預收抵充也算有效配置', [{ amount: 5000 }, { amount: 15000, source: 'prepaid' as const }], 'paid'],
  ])('%s → %s', (_name, specs, expected) => {
    const allocations = specs.map((s) => alloc(s));
    expect(periodStatus(PERIOD, allocations)).toBe(expected);
  });

  it('失效的配置不計入', () => {
    const allocations = [alloc({ amount: 20000, active: false })];
    expect(periodStatus(PERIOD, allocations)).toBe('unpaid');
    expect(periodStatus(PERIOD, [...allocations, alloc({ amount: 5000 })])).toBe('partial');
  });

  it('其他期別的配置不計入', () => {
    expect(periodStatus(PERIOD, [alloc({ amount: 20000, periodId: 'other' })])).toBe('unpaid');
  });

  it('已取消的期別回傳 cancelled，不論配置', () => {
    const cancelled = { ...PERIOD, state: 'cancelled' as const };
    expect(periodStatus(cancelled, [alloc({ amount: 20000 })])).toBe('cancelled');
  });

  it('應收 0 元的期別視為已入帳', () => {
    expect(periodStatus({ ...PERIOD, amount: 0 }, [])).toBe('paid');
  });
});

describe('isOverdue（到期日加寬限天數之後仍未足額）', () => {
  // 到期日 2026-03-05，寬限 3 天：03-08 是寬限最後一天，03-09 是寬限次日。
  it.each([
    ['到期日之前', '2026-03-04', 3, false],
    ['到期日當天', '2026-03-05', 3, false],
    ['寬限第 1 天', '2026-03-06', 3, false],
    ['寬限最後一天', '2026-03-08', 3, false],
    ['寬限次日', '2026-03-09', 3, true],
    ['寬限次日之後', '2026-04-20', 3, true],
    ['寬限 0 天：到期日當天', '2026-03-05', 0, false],
    ['寬限 0 天：次日', '2026-03-06', 0, true],
    ['寬限 7 天：最後一天', '2026-03-12', 7, false],
    ['寬限 7 天：次日', '2026-03-13', 7, true],
  ])('未入帳，%s（今天 %s，寬限 %s 天）→ %s', (_name, today, grace, expected) => {
    expect(isOverdue(PERIOD, [], grace, today)).toBe(expected);
  });

  it('寬限天數跨月底與跨年也照日曆日算', () => {
    const p = { ...PERIOD, dueDate: '2026-12-30' };
    expect(isOverdue(p, [], 3, '2027-01-02')).toBe(false);
    expect(isOverdue(p, [], 3, '2027-01-03')).toBe(true);
    const feb = { ...PERIOD, dueDate: '2028-02-27' };
    expect(isOverdue(feb, [], 3, '2028-03-01')).toBe(false); // 閏年 2/28、2/29、3/1 都在寬限內
    expect(isOverdue(feb, [], 3, '2028-03-02')).toBe(true);
  });

  it('部分入帳仍會逾期', () => {
    expect(isOverdue(PERIOD, [alloc({ amount: 19999 })], 3, '2026-03-09')).toBe(true);
  });

  it('足額後不逾期，即使已過寬限期', () => {
    expect(isOverdue(PERIOD, [alloc({ amount: 20000 })], 3, '2026-06-01')).toBe(false);
  });

  it('逾期後補足額，狀態回到不逾期；配置失效後再度逾期', () => {
    const paid = alloc({ amount: 20000 });
    expect(isOverdue(PERIOD, [paid], 3, '2026-03-20')).toBe(false);
    expect(isOverdue(PERIOD, [{ ...paid, active: false }], 3, '2026-03-20')).toBe(true);
  });

  it('已取消的期別不逾期', () => {
    expect(isOverdue({ ...PERIOD, state: 'cancelled' }, [], 3, '2026-06-01')).toBe(false);
  });

  it('寬限天數不是 0 以上整數時丟 RangeError', () => {
    expect(() => isOverdue(PERIOD, [], -1, '2026-03-09')).toThrow(RangeError);
    expect(() => isOverdue(PERIOD, [], 1.5, '2026-03-09')).toThrow(RangeError);
  });

  it('today 格式錯誤時丟 RangeError', () => {
    expect(() => isOverdue(PERIOD, [], 3, '2026-3-9')).toThrow(RangeError);
  });
});
