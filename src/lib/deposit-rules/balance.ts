// 押金餘額與結算金額的純函式（ADR-0015 決議 6、8）。
// 金額一律是整數新台幣元，用 Number.isSafeInteger 檢查（ADR-0015 決議 5）。
// 餘額一律由 `liability.deposit.{case}` 即時加總，這裡不存餘額，只檢查呼叫端傳入的數字。

export type DepositAmountError = 'invalid_amount' | 'insufficient_balance';

export type CheckDepositBalanceResult = { ok: true; remaining: number } | { ok: false; error: DepositAmountError };

function isAmount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveAmount(value: number): boolean {
  return isAmount(value) && value > 0;
}

/**
 * 扣抵或返還後餘額必須不小於 0。deduction 必須是大於 0 的安全整數，balance 必須是不小於 0 的安全整數。
 * 資料庫端由 `SELECT ... FOR UPDATE` 鎖押金台帳後呼叫，避免並行扣抵。
 */
export function checkDepositBalance(balance: number, deduction: number): CheckDepositBalanceResult {
  if (!isAmount(balance) || !isPositiveAmount(deduction)) {
    return { ok: false, error: 'invalid_amount' };
  }
  if (deduction > balance) return { ok: false, error: 'insufficient_balance' };
  return { ok: true, remaining: balance - deduction };
}

export interface SettlementAmounts {
  /** 約定金額（`deposit_ledgers.expected_amount`）。 */
  expected: number;
  /** 已收金額，押金分次收取時可能小於約定金額。 */
  received: number;
  /** 扣抵合計。 */
  deductionTotal: number;
  /** 應返還金額 = 已收 - 扣抵合計。 */
  refundable: number;
}

export type SettlementAmountsResult =
  | { ok: true; amounts: SettlementAmounts }
  | { ok: false; error: DepositAmountError };

/**
 * 押金結算單的金額（P0-18 AC1）。應返還金額以已收計算，不以約定金額計算。
 * 已收與約定金額不同不算錯誤。扣抵合計超過已收時回傳 insufficient_balance。
 */
export function settlementAmounts(
  expected: number,
  received: number,
  deductions: readonly number[],
): SettlementAmountsResult {
  if (!isAmount(expected) || !isAmount(received)) return { ok: false, error: 'invalid_amount' };

  let deductionTotal = 0;
  for (const deduction of deductions) {
    if (!isPositiveAmount(deduction)) return { ok: false, error: 'invalid_amount' };
    deductionTotal += deduction;
    if (!Number.isSafeInteger(deductionTotal)) return { ok: false, error: 'invalid_amount' };
  }

  if (deductionTotal > received) return { ok: false, error: 'insufficient_balance' };
  return { ok: true, amounts: { expected, received, deductionTotal, refundable: received - deductionTotal } };
}
