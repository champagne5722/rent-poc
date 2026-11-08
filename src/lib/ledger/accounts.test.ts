import { describe, expect, it } from 'vitest';
import {
  bankAccount,
  deductionIncomeAccount,
  depositAccount,
  isValidLedgerId,
  naturalBalance,
  parseAccountCode,
  prepaidRentAccount,
  rentIncomeAccount,
} from './accounts';

// 科目編碼依 ADR-0015 決議 2。期望值都是手寫字面值。
describe('科目編碼產生', () => {
  it.each([
    ['押金負債', depositAccount('CASE01'), 'liability.deposit.CASE01'],
    ['預收租金負債', prepaidRentAccount('CASE01'), 'liability.prepaid_rent.CASE01'],
    ['收款帳戶', bankAccount('PAY_9'), 'asset.bank.PAY_9'],
    ['租金收入', rentIncomeAccount('CASE01'), 'income.rent.CASE01'],
    ['扣抵收入', deductionIncomeAccount('CASE01'), 'income.deduction.CASE01'],
  ])('%s', (_name, actual, expected) => {
    expect(actual).toBe(expected);
  });

  it.each(['', 'a.b', 'a b', 'a/b', '案件', 'x'.repeat(65), '.', ' A'])('拒絕不合法的 ID %j', (id) => {
    expect(isValidLedgerId(id)).toBe(false);
    expect(() => depositAccount(id)).toThrow(RangeError);
    expect(() => bankAccount(id)).toThrow(RangeError);
  });

  it('ULID 與 UUID 風格的 ID 合法', () => {
    expect(isValidLedgerId('01J9Z3K7M8Q2R4T6V8X0Y1A2B3')).toBe(true);
    expect(isValidLedgerId('3f2b8c1e-aaaa-4bbb-8ccc-123456789abc')).toBe(true);
  });

  it('非字串不合法', () => {
    expect(isValidLedgerId(undefined)).toBe(false);
    expect(isValidLedgerId(12)).toBe(false);
  });
});

describe('parseAccountCode', () => {
  it('拆出類型、名稱與 ID', () => {
    expect(parseAccountCode('liability.prepaid_rent.CASE01')).toEqual({
      kind: 'liability',
      name: 'prepaid_rent',
      id: 'CASE01',
    });
  });

  it.each(['', 'asset.bank', 'expense.rent.C1', 'asset.bank.C1.extra', 'Asset.bank.C1', 'asset..C1'])(
    '不合法的編碼 %j 回傳 null',
    (code) => {
      expect(parseAccountCode(code)).toBeNull();
    },
  );
});

describe('naturalBalance（自然方向餘額）', () => {
  it('資產看借減貸，負債與收入看貸減借', () => {
    expect(naturalBalance('asset.bank.A', { debit: 500, credit: 120 })).toBe(380);
    expect(naturalBalance('liability.deposit.C', { debit: 100, credit: 600 })).toBe(500);
    expect(naturalBalance('income.rent.C', { debit: 0, credit: 70 })).toBe(70);
  });

  it('編碼不合法時丟錯', () => {
    expect(() => naturalBalance('oops', { debit: 0, credit: 0 })).toThrow(RangeError);
  });
});
