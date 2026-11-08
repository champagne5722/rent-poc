import { describe, expect, it } from 'vitest';
import { OBJECTION_STATES, type ObjectionState } from './objection';
import { settlementWarnings, type SettlementDeduction } from './warnings';

const d = (id: string, amount: number, objection: ObjectionState): SettlementDeduction => ({ id, amount, objection });

describe('settlementWarnings', () => {
  it('沒有扣抵：沒有警告', () => {
    expect(settlementWarnings([])).toEqual([]);
  });

  it.each(OBJECTION_STATES.filter((s) => s !== 'objected'))('扣抵的異議狀態是 %s：沒有警告', (state) => {
    expect(settlementWarnings([d('a', 1000, state)])).toEqual([]);
  });

  it('只有一筆有異議：一個警告，帶那筆的 id 與金額', () => {
    expect(settlementWarnings([d('a', 1000, 'none'), d('b', 2500, 'objected'), d('c', 300, 'withdrawn')])).toEqual([
      { code: 'disputed_deductions', deductionIds: ['b'], count: 1, totalAmount: 2500, requiresConfirmation: true },
    ]);
  });

  it('多筆有異議：依輸入順序列出，金額加總', () => {
    expect(
      settlementWarnings([d('a', 1000, 'objected'), d('b', 50, 'none'), d('c', 2000, 'objected')]),
    ).toEqual([
      {
        code: 'disputed_deductions',
        deductionIds: ['a', 'c'],
        count: 2,
        totalAmount: 3000,
        requiresConfirmation: true,
      },
    ]);
  });

  it('扣抵金額 0 也算', () => {
    expect(settlementWarnings([d('a', 0, 'objected')])[0]?.totalAmount).toBe(0);
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('金額 %s 不是非負整數元丟 RangeError', (amount) => {
    expect(() => settlementWarnings([d('a', amount, 'objected')])).toThrow(RangeError);
  });

  it('沒有異議的扣抵金額不合法也要丟 RangeError', () => {
    expect(() => settlementWarnings([d('a', -5, 'none')])).toThrow(RangeError);
  });

  it('不改動輸入', () => {
    const input = [d('a', 1, 'objected')];
    const snapshot = JSON.stringify(input);
    settlementWarnings(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
