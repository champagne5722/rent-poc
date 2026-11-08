// 分錄平衡檢查（ADR-0015 決議 3、5）。純函式，不看事件類型。
// 資料庫觸發器之後會再擋一次，這裡讓應用層在寫入前就拿到完整的錯誤清單。

import { parseAccountCode } from './accounts';
import { ledgerError, type JournalLine, type LedgerError, type LedgerResult } from './types';

/** 檢查單一金額欄。不合法時把錯誤放進 `errors`，回傳 false。 */
function checkAmount(
  value: unknown,
  side: '借方' | '貸方',
  lineIndex: number,
  errors: LedgerError[],
): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    errors.push(ledgerError('non_integer', `第 ${lineIndex + 1} 列${side}金額必須是整數`, lineIndex));
    return false;
  }
  if (value < 0) {
    errors.push(ledgerError('negative_amount', `第 ${lineIndex + 1} 列${side}金額不得為負`, lineIndex));
    return false;
  }
  if (!Number.isSafeInteger(value)) {
    errors.push(ledgerError('unsafe_integer', `第 ${lineIndex + 1} 列${side}金額超過安全整數範圍`, lineIndex));
    return false;
  }
  return true;
}

/**
 * 通過的條件：
 * 1. 至少 2 列明細。
 * 2. 每列的科目編碼合法。
 * 3. 每列的借方與貸方都是安全整數，不為負，且恰好一欄大於 0。
 * 4. 借方合計等於貸方合計。
 */
export function validateJournal(journal: { readonly lines: readonly JournalLine[] }): LedgerResult<void> {
  const errors: LedgerError[] = [];
  const lines: unknown = journal.lines;

  if (!Array.isArray(lines) || lines.length < 2) {
    errors.push(ledgerError('too_few_lines', '每筆分錄至少要有 2 列明細'));
  }
  if (!Array.isArray(lines)) return { ok: false, errors };

  let allAmountsValid = true;
  let debitTotal = BigInt(0);
  let creditTotal = BigInt(0);

  lines.forEach((raw: unknown, index) => {
    if (typeof raw !== 'object' || raw === null) {
      errors.push(ledgerError('invalid_lines', `第 ${index + 1} 列不是明細物件`, index));
      allAmountsValid = false;
      return;
    }
    const line = raw as Partial<JournalLine>;

    if (typeof line.account !== 'string' || parseAccountCode(line.account) === null) {
      errors.push(ledgerError('invalid_account', `第 ${index + 1} 列的科目編碼不合法`, index));
    }

    const debitOk = checkAmount(line.debit, '借方', index, errors);
    const creditOk = checkAmount(line.credit, '貸方', index, errors);
    if (!debitOk || !creditOk) {
      allAmountsValid = false;
      return;
    }

    const debit = line.debit as number;
    const credit = line.credit as number;
    if (debit > 0 && credit > 0) {
      errors.push(ledgerError('line_both_sides', `第 ${index + 1} 列借方與貸方不得同時大於 0`, index));
      allAmountsValid = false;
    } else if (debit === 0 && credit === 0) {
      errors.push(ledgerError('line_empty', `第 ${index + 1} 列借方與貸方至少要有一欄大於 0`, index));
      allAmountsValid = false;
    }
    // 合計用 BigInt，避免加總超過安全整數後失真。
    debitTotal += BigInt(debit);
    creditTotal += BigInt(credit);
  });

  if (allAmountsValid && debitTotal !== creditTotal) {
    errors.push(
      ledgerError('unbalanced', `借方合計 ${debitTotal} 不等於貸方合計 ${creditTotal}`),
    );
  }

  return errors.length === 0 ? { ok: true, value: undefined } : { ok: false, errors };
}
