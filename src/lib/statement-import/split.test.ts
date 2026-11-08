import { describe, expect, it } from 'vitest';
import { validateSplit } from './split';
import type { SplitPart } from './types';

const part = (caseId: string, amount: number, purpose: SplitPart['purpose'] = 'rent'): SplitPart => ({ caseId, purpose, amount });

describe('validateSplit：拆分金額合計必須等於該列', () => {
  it('合計相等：通過', () => {
    expect(validateSplit(30000, [part('case-1', 18000), part('case-2', 12000)])).toEqual({ ok: true });
  });
  it('只拆給一個案件、金額全額：通過', () => {
    expect(validateSplit(30000, [part('case-1', 30000)])).toEqual({ ok: true });
  });
  it('同一案件的押金與租金分開兩筆：通過', () => {
    expect(validateSplit(30000, [part('case-1', 10000, 'security_deposit'), part('case-1', 20000, 'rent')])).toEqual({ ok: true });
  });

  it.each([
    ['合計少於', [part('case-1', 18000), part('case-2', 11999)], 29999],
    ['合計多於', [part('case-1', 18000), part('case-2', 12001)], 30001],
    ['只有一筆但金額不足', [part('case-1', 29999)], 29999],
  ])('拒絕：%s', (_name, parts, actual) => {
    expect(validateSplit(30000, parts)).toEqual({ ok: false, reason: 'sum_mismatch', expected: 30000, actual });
  });

  it('拒絕：沒有任何拆分', () => {
    expect(validateSplit(30000, [])).toEqual({ ok: false, reason: 'no_parts', expected: 30000, actual: 0 });
  });

  it.each([
    ['零元', 0],
    ['負數', -100],
    ['小數', 100.5],
    ['不是安全整數', 2 ** 53],
    ['NaN', Number.NaN],
  ])('拒絕：其中一筆是%s', (_name, bad) => {
    const result = validateSplit(30000, [part('case-1', 30000 - 100), part('case-2', bad)]);
    expect(result).toMatchObject({ ok: false, reason: 'invalid_part_amount', expected: 30000 });
  });

  it('拒絕：同一案件同一用途出現兩次（每個案件一筆入帳確認）', () => {
    const result = validateSplit(30000, [part('case-1', 10000), part('case-1', 20000)]);
    expect(result).toMatchObject({ ok: false, reason: 'duplicate_case_purpose' });
  });

  it('金額相等但有不合法的拆分時，優先回報不合法的拆分', () => {
    // 40000 + -10000 = 30000，合計相等也不得通過。
    expect(validateSplit(30000, [part('case-1', 40000), part('case-2', -10000)])).toMatchObject({
      ok: false,
      reason: 'invalid_part_amount',
    });
  });

  it('該列金額不合法丟 RangeError', () => {
    expect(() => validateSplit(0, [part('case-1', 0)])).toThrow(RangeError);
    expect(() => validateSplit(100.5, [part('case-1', 100)])).toThrow(RangeError);
    expect(() => validateSplit(2 ** 53, [part('case-1', 1)])).toThrow(RangeError);
  });
});
