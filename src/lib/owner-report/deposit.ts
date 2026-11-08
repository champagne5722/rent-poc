// 押金區段：約定、已收、本月扣抵、本月返還、月底餘額、收款帳戶持有人、備註。
// 餘額一律由 `liability.deposit.{case}` 即時加總（ADR-0015 決議 6），台帳只提供約定金額。
// 沖銷會抵銷原分錄的影響：被沖銷的入帳不算已收，被沖銷的扣抵不算本月扣抵。

import {
  depositAccount,
  depositDeducted,
  depositReturned,
  isReversal,
  receiptConfirmed,
  type Journal,
} from '../ledger';
import { toTaipeiDate } from '../receivables';
import type { ReportContext } from './context';
import type { DepositDeductionRow, DepositRow } from './types';

interface DepositEffect {
  received: number;
  deducted: number;
  returned: number;
}

const ZERO: DepositEffect = { received: 0, deducted: 0, returned: 0 };

/** 一筆分錄對押金負債的影響。沖銷等於原分錄影響的相反數。 */
function depositEffect(ctx: ReportContext, journal: Journal): DepositEffect {
  if (isReversal(journal)) {
    const original = depositEffect(ctx, ctx.originalOf(journal));
    return { received: -original.received, deducted: -original.deducted, returned: -original.returned };
  }
  const account = depositAccount(journal.caseId);
  let debit = 0;
  let credit = 0;
  for (const line of journal.lines) {
    if (line.account === account) {
      debit += line.debit;
      credit += line.credit;
    }
  }
  if (journal.eventType === receiptConfirmed.type) return { ...ZERO, received: credit };
  if (journal.eventType === depositDeducted.type) return { ...ZERO, deducted: debit };
  if (journal.eventType === depositReturned.type) return { ...ZERO, returned: debit };
  return ZERO;
}

export function buildDeposit(ctx: ReportContext): DepositRow[] {
  const ledgers = new Map(ctx.input.depositLedgers.map((l) => [l.caseId, l] as const));
  const rows: DepositRow[] = [];

  for (const unit of ctx.units) {
    const journals = ctx.journalsByCase.get(unit.caseId) ?? [];
    const ledger = ledgers.get(unit.caseId);
    const balance = ctx.balanceOf(unit.caseId, depositAccount(unit.caseId));

    let received = 0;
    let deducted = 0;
    let returned = 0;
    for (const journal of journals) {
      const effect = depositEffect(ctx, journal);
      received += effect.received;
      if (ctx.isInMonth(journal)) {
        deducted += effect.deducted;
        returned += effect.returned;
      }
    }
    if (!ledger && balance === 0 && received === 0 && deducted === 0 && returned === 0) continue;

    let account = null;
    if (ledger && ledger.paymentAccountId !== null) {
      account = ctx.accounts.get(ledger.paymentAccountId) ?? null;
      if (!account) throw new RangeError(`押金台帳的收款帳戶不在輸入內：${ledger.paymentAccountId}`);
    }

    const acknowledgment = ctx.input.holderAcknowledgments
      .filter((a) => a.caseId === unit.caseId && toTaipeiDate(a.confirmedAt) <= ctx.bounds.end)
      .sort((a, b) => Date.parse(b.confirmedAt) - Date.parse(a.confirmedAt))[0];
    const remarkParts: string[] = [];
    if (acknowledgment) {
      remarkParts.push(`${acknowledgment.confirmedBy} 於 ${toTaipeiDate(acknowledgment.confirmedAt)} 確認`);
    }
    if (account?.holderKind === 'manager' && unit.agreedHandoverDays !== null) {
      remarkParts.push(`約定 ${unit.agreedHandoverDays} 日內交付`);
    }

    const deductions: DepositDeductionRow[] = [];
    for (const d of ctx.input.deductions) {
      if (d.caseId !== unit.caseId) continue;
      const journal = ctx.journalById.get(d.journalId);
      if (!journal) {
        if (!ctx.input.journals.some((j) => j.journalId === d.journalId)) {
          throw new RangeError(`扣抵 ${d.deductionId} 的分錄不在輸入內：${d.journalId}`);
        }
        continue;
      }
      if (!ctx.isInMonth(journal)) continue;
      deductions.push({
        deductionId: d.deductionId,
        amount: depositEffect(ctx, journal).deducted,
        reason: d.reason,
        disputed: d.disputed,
        reversed: ctx.reversedIds.has(journal.journalId),
      });
    }

    rows.push({
      unitId: unit.unitId,
      address: unit.address,
      expected: ledger ? ledger.expectedAmount : null,
      received,
      deducted,
      returned,
      balance,
      holderKind: account ? account.holderKind : null,
      holderMaskedId: account ? account.maskedId : null,
      holderIsCash: account ? account.isCash : false,
      remark: remarkParts.length > 0 ? remarkParts.join('，') : null,
      deductions,
    });
  }
  return rows;
}
