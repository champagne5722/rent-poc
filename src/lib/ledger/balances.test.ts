import { describe, expect, it } from 'vitest';
import { naturalBalance } from './accounts';
import { accountTotals } from './balances';

describe('accountTotals', () => {
  it('同一科目跨分錄加總借方與貸方', () => {
    const totals = accountTotals([
      {
        lines: [
          { account: 'asset.bank.P1', debit: 100, credit: 0 },
          { account: 'liability.deposit.C1', debit: 0, credit: 100 },
        ],
      },
      {
        lines: [
          { account: 'liability.deposit.C1', debit: 30, credit: 0 },
          { account: 'asset.bank.P1', debit: 0, credit: 30 },
        ],
      },
    ]);
    expect(totals.get('asset.bank.P1')).toEqual({ debit: 100, credit: 30 });
    expect(totals.get('liability.deposit.C1')).toEqual({ debit: 30, credit: 100 });
    expect(naturalBalance('liability.deposit.C1', totals.get('liability.deposit.C1')!)).toBe(70);
  });

  it('沒有分錄時是空的', () => {
    expect(accountTotals([]).size).toBe(0);
  });

  it('加總超過安全整數時丟錯', () => {
    const line = [
      { account: 'asset.bank.P1', debit: Number.MAX_SAFE_INTEGER, credit: 0 },
      { account: 'income.rent.C1', debit: 0, credit: Number.MAX_SAFE_INTEGER },
    ];
    expect(() => accountTotals([{ lines: line }, { lines: line }])).toThrow(RangeError);
  });
});
