// 押金結算單送簽前的警告（MIL-137、ADR-0051 決議 7、PRD P0-18 AC2）。
// 純函式，沒有 I/O。警告不阻擋送簽，使用者確認後才送。

import type { ObjectionState } from './objection';

export interface SettlementDeduction {
  id: string;
  /** 整數新台幣元。 */
  amount: number;
  objection: ObjectionState;
}

export interface SettlementWarning {
  code: 'disputed_deductions';
  /** 有異議的扣抵 id，依輸入順序。 */
  deductionIds: string[];
  count: number;
  /** 有異議的扣抵金額合計，整數元。 */
  totalAmount: number;
  /** 送簽前必須由使用者確認。 */
  requiresConfirmation: true;
}

/** 有「有異議」的扣抵時回傳一個警告，否則回傳空陣列。已撤回的異議不算。 */
export function settlementWarnings(deductions: readonly SettlementDeduction[]): SettlementWarning[] {
  const disputed: SettlementDeduction[] = [];
  for (const deduction of deductions) {
    if (!Number.isSafeInteger(deduction.amount) || deduction.amount < 0) {
      throw new RangeError(`扣抵 ${deduction.id} 的金額必須是非負整數元：${String(deduction.amount)}`);
    }
    if (deduction.objection === 'objected') disputed.push(deduction);
  }
  if (disputed.length === 0) return [];

  const totalAmount = disputed.reduce((sum, d) => sum + d.amount, 0);
  if (!Number.isSafeInteger(totalAmount)) throw new RangeError('有異議的扣抵金額合計超出安全整數範圍');
  return [
    {
      code: 'disputed_deductions',
      deductionIds: disputed.map((d) => d.id),
      count: disputed.length,
      totalAmount,
      requiresConfirmation: true,
    },
  ];
}
