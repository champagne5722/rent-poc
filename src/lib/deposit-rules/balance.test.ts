import { describe, expect, it } from 'vitest';
import { checkDepositBalance, settlementAmounts } from './balance';

describe('checkDepositBalance：餘額不得為負（ADR-0015 決議 6）', () => {
  it.each([
    ['扣抵小於餘額', 10000, 3000, { ok: true, remaining: 7000 }],
    ['扣抵等於餘額，歸 0', 10000, 10000, { ok: true, remaining: 0 }],
    ['最小扣抵 1 元', 1, 1, { ok: true, remaining: 0 }],
    ['扣成負數', 10000, 10001, { ok: false, error: 'insufficient_balance' }],
    ['餘額為 0 仍要扣', 0, 1, { ok: false, error: 'insufficient_balance' }],
    ['扣抵為 0', 10000, 0, { ok: false, error: 'invalid_amount' }],
    ['扣抵為負數', 10000, -1, { ok: false, error: 'invalid_amount' }],
    ['扣抵為小數', 10000, 100.5, { ok: false, error: 'invalid_amount' }],
    ['扣抵為 NaN', 10000, Number.NaN, { ok: false, error: 'invalid_amount' }],
    ['扣抵為 Infinity', 10000, Number.POSITIVE_INFINITY, { ok: false, error: 'invalid_amount' }],
    ['扣抵超過安全整數', 10000, Number.MAX_SAFE_INTEGER + 1, { ok: false, error: 'invalid_amount' }],
    ['餘額為負（帳已壞）', -1, 1, { ok: false, error: 'invalid_amount' }],
    ['餘額為小數', 100.5, 1, { ok: false, error: 'invalid_amount' }],
  ] as const)('%s', (_name, balance, deduction, expected) => {
    expect(checkDepositBalance(balance, deduction)).toEqual(expected);
  });
});

describe('settlementAmounts：約定金額、已收、扣抵合計、應返還金額（供 E2-6）', () => {
  it.each([
    ['無扣抵：全額返還', 30000, 30000, [], { ok: true, amounts: { expected: 30000, received: 30000, deductionTotal: 0, refundable: 30000 } }],
    ['有扣抵：返還餘額', 30000, 30000, [2000, 3500], { ok: true, amounts: { expected: 30000, received: 30000, deductionTotal: 5500, refundable: 24500 } }],
    ['扣抵等於已收：返還 0', 30000, 30000, [10000, 20000], { ok: true, amounts: { expected: 30000, received: 30000, deductionTotal: 30000, refundable: 0 } }],
    ['押金分次收取未收足：以已收計算', 30000, 10000, [], { ok: true, amounts: { expected: 30000, received: 10000, deductionTotal: 0, refundable: 10000 } }],
    ['押金分次收取未收足且有扣抵', 30000, 10000, [4000], { ok: true, amounts: { expected: 30000, received: 10000, deductionTotal: 4000, refundable: 6000 } }],
    ['已收大於約定：不當錯誤', 30000, 31000, [1000], { ok: true, amounts: { expected: 30000, received: 31000, deductionTotal: 1000, refundable: 30000 } }],
    ['完全未收', 30000, 0, [], { ok: true, amounts: { expected: 30000, received: 0, deductionTotal: 0, refundable: 0 } }],
    ['扣抵合計超過已收', 30000, 10000, [6000, 4001], { ok: false, error: 'insufficient_balance' }],
    ['未收且有扣抵', 30000, 0, [1], { ok: false, error: 'insufficient_balance' }],
    ['有一筆扣抵為 0', 30000, 30000, [1000, 0], { ok: false, error: 'invalid_amount' }],
    ['有一筆扣抵為負', 30000, 30000, [-1000], { ok: false, error: 'invalid_amount' }],
    ['有一筆扣抵為小數', 30000, 30000, [10.5], { ok: false, error: 'invalid_amount' }],
    ['約定金額為負', -1, 0, [], { ok: false, error: 'invalid_amount' }],
    ['已收為小數', 30000, 100.5, [], { ok: false, error: 'invalid_amount' }],
    ['已收為負', 30000, -5, [], { ok: false, error: 'invalid_amount' }],
    ['扣抵合計超過安全整數', 30000, Number.MAX_SAFE_INTEGER, [Number.MAX_SAFE_INTEGER, 1], { ok: false, error: 'invalid_amount' }],
  ] as const)('%s', (_name, expected, received, deductions, result) => {
    expect(settlementAmounts(expected, received, [...deductions])).toEqual(result);
  });

  it('不改動傳入的扣抵陣列', () => {
    const deductions = [100, 200];
    settlementAmounts(1000, 1000, deductions);
    expect(deductions).toEqual([100, 200]);
  });
});
