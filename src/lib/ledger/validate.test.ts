import { describe, expect, it } from 'vitest';
import { validateJournal } from './validate';
import type { LedgerErrorCode } from './types';

const BANK = 'asset.bank.PAY1';
const DEPOSIT = 'liability.deposit.CASE1';
const RENT = 'income.rent.CASE1';

type Line = { account: string; debit: number; credit: number };
const dr = (account: string, debit: number): Line => ({ account, debit, credit: 0 });
const cr = (account: string, credit: number): Line => ({ account, debit: 0, credit });

function codes(lines: Line[]): LedgerErrorCode[] {
  const result = validateJournal({ lines });
  return result.ok ? [] : result.errors.map((e) => e.code);
}

describe('validateJournal：通過的情況', () => {
  it.each([
    ['一借一貸', [dr(BANK, 30000), cr(RENT, 30000)]],
    ['一借多貸（押金加租金）', [dr(BANK, 90000), cr(DEPOSIT, 60000), cr(RENT, 30000)]],
    ['多借一貸（移交形狀）', [dr(DEPOSIT, 60000), dr('liability.prepaid_rent.CASE1', 500), cr(BANK, 60500)]],
    ['金額剛好是安全整數上限', [dr(BANK, Number.MAX_SAFE_INTEGER), cr(RENT, Number.MAX_SAFE_INTEGER)]],
  ])('%s', (_name, lines) => {
    expect(validateJournal({ lines })).toEqual({ ok: true, value: undefined });
  });
});

describe('validateJournal：明細列數', () => {
  it.each([
    ['沒有明細', []],
    ['只有一列', [dr(BANK, 100)]],
  ])('%s → too_few_lines', (_name, lines) => {
    expect(codes(lines)).toContain('too_few_lines');
  });

  it('明細不是陣列 → too_few_lines', () => {
    const result = validateJournal({ lines: undefined as unknown as Line[] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].code).toBe('too_few_lines');
  });
});

describe('validateJournal：借貸合計', () => {
  it('借方合計不等於貸方合計 → unbalanced，訊息含兩邊合計', () => {
    const result = validateJournal({ lines: [dr(BANK, 100), cr(RENT, 99)] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['unbalanced']);
      expect(result.errors[0].message).toContain('100');
      expect(result.errors[0].message).toContain('99');
    }
  });

  it('多列合計相同但各列不同時通過', () => {
    expect(codes([dr(BANK, 10), dr(BANK, 20), cr(RENT, 5), cr(DEPOSIT, 25)])).toEqual([]);
  });

  it('合計超過安全整數但兩邊相等時仍通過（用 BigInt 加總，不失真）', () => {
    const half = Number.MAX_SAFE_INTEGER;
    expect(codes([dr(BANK, half), dr(BANK, half), cr(RENT, half), cr(DEPOSIT, half)])).toEqual([]);
  });

  it('合計超過安全整數且兩邊差 1 → unbalanced，不被浮點誤差吃掉', () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(codes([dr(BANK, max), dr(BANK, max), cr(RENT, max), cr(DEPOSIT, max - 1)])).toEqual(['unbalanced']);
  });
});

describe('validateJournal：每列恰好一欄大於 0', () => {
  it('一列借貸都大於 0 → line_both_sides', () => {
    const lines = [{ account: BANK, debit: 100, credit: 100 }, cr(RENT, 100)];
    expect(codes(lines)).toEqual(['line_both_sides']);
  });

  it('一列借貸都是 0 → line_empty', () => {
    const lines = [{ account: BANK, debit: 0, credit: 0 }, dr(BANK, 100), cr(RENT, 100)];
    expect(codes(lines)).toEqual(['line_empty']);
  });

  it('錯誤帶出是第幾列', () => {
    const lines = [dr(BANK, 100), { account: BANK, debit: 0, credit: 0 }, cr(RENT, 100)];
    const result = validateJournal({ lines });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].lineIndex).toBe(1);
  });
});

describe('validateJournal：金額必須是安全整數', () => {
  it.each([
    ['負數借方', { account: BANK, debit: -100, credit: 0 }, 'negative_amount'],
    ['負數貸方', { account: BANK, debit: 0, credit: -1 }, 'negative_amount'],
    ['小數', { account: BANK, debit: 10.5, credit: 0 }, 'non_integer'],
    ['NaN', { account: BANK, debit: Number.NaN, credit: 0 }, 'non_integer'],
    ['Infinity', { account: BANK, debit: Number.POSITIVE_INFINITY, credit: 0 }, 'non_integer'],
    ['字串金額', { account: BANK, debit: '100' as unknown as number, credit: 0 }, 'non_integer'],
    ['超過安全整數', { account: BANK, debit: Number.MAX_SAFE_INTEGER + 1, credit: 0 }, 'unsafe_integer'],
    ['貸方超過安全整數', { account: BANK, debit: 0, credit: 2 ** 60 }, 'unsafe_integer'],
  ] as const)('%s → %s', (_name, badLine, code) => {
    const lines = [badLine, cr(RENT, 100)];
    expect(codes(lines)).toContain(code);
  });

  it('有金額錯誤時不再報借貸不平衡（避免誤導）', () => {
    expect(codes([{ account: BANK, debit: -5, credit: 0 }, cr(RENT, 100)])).toEqual(['negative_amount']);
  });
});

describe('validateJournal：科目編碼', () => {
  it.each(['', 'bank', 'asset.bank', 'expense.rent.C1', 'asset.bank.has space'])(
    '科目 %j → invalid_account',
    (account) => {
      expect(codes([dr(account, 100), cr(RENT, 100)])).toEqual(['invalid_account']);
    },
  );
});

describe('validateJournal：明細列格式', () => {
  it('明細列不是物件 → invalid_lines', () => {
    const lines = [null, cr(RENT, 100)] as unknown as Line[];
    expect(codes(lines)).toContain('invalid_lines');
  });
});
