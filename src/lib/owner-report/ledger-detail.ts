// 入帳與沖銷明細、來源比例。報表月份依分錄的 `posted_at`（ADR-0015 決議 4）。
// 上月分錄在本月被沖銷時，沖銷列出現在本月，上月報表不變。

import {
  depositAccount,
  isReversal,
  parseAccountCode,
  prepaidRentAccount,
  receiptConfirmed,
  rentIncomeAccount,
  type Journal,
} from '../ledger';
import type { ReportContext } from './context';
import type {
  LedgerDetailRow,
  LedgerDetailType,
  ReportPaymentAccount,
  ReportReceipt,
  ReportSource,
  SourceBreakdown,
} from './types';

export const SOURCE_ORDER: readonly ReportSource[] = ['manual', 'statement_file', 'cash'];

interface ReceiptFacts {
  receipt: ReportReceipt;
  account: ReportPaymentAccount;
  source: ReportSource;
}

function receiptFacts(ctx: ReportContext, journal: Journal, receipts: Map<string, ReportReceipt>): ReceiptFacts {
  const receipt = receipts.get(journal.journalId);
  if (!receipt) throw new RangeError(`入帳分錄 ${journal.journalId} 沒有對應的入帳確認`);
  if (receipt.caseId !== journal.caseId) {
    throw new RangeError(`入帳確認 ${receipt.receiptId} 與分錄 ${journal.journalId} 的案件不同`);
  }
  const bankLines = journal.lines.filter((l) => l.debit > 0 && parseAccountCode(l.account)?.name === 'bank');
  if (bankLines.length !== 1) throw new RangeError(`入帳分錄 ${journal.journalId} 必須恰有一列收款帳戶借方`);
  const accountId = parseAccountCode(bankLines[0].account)?.id ?? '';
  const account = ctx.accounts.get(accountId);
  if (!account) throw new RangeError(`收款帳戶不在輸入內：${accountId}`);
  return { receipt, account, source: account.isCash ? 'cash' : receipt.source };
}

function joinNote(parts: Array<string | null>): string | null {
  const kept = parts.filter((p): p is string => p !== null && p !== '');
  return kept.length > 0 ? kept.join('，') : null;
}

export interface LedgerDetailResult {
  rows: LedgerDetailRow[];
  sourceBreakdown: SourceBreakdown;
}

export function buildLedgerDetail(ctx: ReportContext): LedgerDetailResult {
  const receipts = new Map(ctx.input.receipts.map((r) => [r.journalId, r] as const));
  const reversedIds = new Set<string>();
  for (const journal of ctx.journals) {
    if (isReversal(journal)) reversedIds.add(journal.reversesJournalId);
  }

  const rows: LedgerDetailRow[] = [];
  const bySource: Record<ReportSource, number> = { manual: 0, statement_file: 0, cash: 0 };

  for (const journal of ctx.journals) {
    if (!ctx.isInMonth(journal)) continue;
    const unit = ctx.unitByCase.get(journal.caseId);
    if (!unit) continue;
    const common = { journalId: journal.journalId, unitId: unit.unitId, address: unit.address };

    if (isReversal(journal)) {
      const original = ctx.originalOf(journal);
      const facts = original.eventType === receiptConfirmed.type ? receiptFacts(ctx, original, receipts) : null;
      let total = 0;
      for (const line of journal.lines) total += line.debit;
      rows.push({
        ...common,
        type: 'reversal',
        effectiveDate: journal.effectiveDate,
        postedDate: ctx.postedDate(journal),
        amount: -total,
        paymentAccountMask: facts ? facts.account.maskedId : null,
        source: facts ? facts.source : null,
        note: joinNote([`沖銷分錄 ${original.journalId}`, `原因：${journal.reason}`]),
        reversed: false,
        reversesJournalId: journal.reversesJournalId,
      });
      continue;
    }

    if (journal.eventType !== receiptConfirmed.type) continue;
    const facts = receiptFacts(ctx, journal, receipts);
    const credits: Array<[LedgerDetailType, string]> = [
      ['deposit', depositAccount(journal.caseId)],
      ['rent', rentIncomeAccount(journal.caseId)],
      ['prepaid_rent', prepaidRentAccount(journal.caseId)],
    ];
    for (const [type, account] of credits) {
      let amount = 0;
      for (const line of journal.lines) if (line.account === account) amount += line.credit;
      if (amount === 0) continue;
      bySource[facts.source] += amount;
      rows.push({
        ...common,
        type,
        effectiveDate: journal.effectiveDate,
        postedDate: ctx.postedDate(journal),
        amount,
        paymentAccountMask: facts.account.isCash ? null : facts.account.maskedId,
        source: facts.source,
        note: facts.receipt.note,
        reversed: reversedIds.has(journal.journalId),
        reversesJournalId: null,
      });
    }
  }

  return { rows, sourceBreakdown: shares(bySource) };
}

/** 依金額算來源比例。用最大餘數法，讓四捨五入後的合計一定是 10000（100.00%）。 */
function shares(bySource: Record<ReportSource, number>): SourceBreakdown {
  let total = 0;
  for (const source of SOURCE_ORDER) total += bySource[source];
  if (!Number.isSafeInteger(total)) throw new RangeError('入帳金額合計超過安全整數範圍');

  const scale = BigInt(10000);
  const bigTotal = BigInt(total);
  const parts = SOURCE_ORDER.map((source, index) => {
    const numerator = BigInt(bySource[source]) * scale;
    return {
      source,
      index,
      floor: bigTotal === BigInt(0) ? BigInt(0) : numerator / bigTotal,
      remainder: bigTotal === BigInt(0) ? BigInt(0) : numerator % bigTotal,
    };
  });
  let left = bigTotal === BigInt(0) ? 0 : 10000 - parts.reduce((sum, p) => sum + Number(p.floor), 0);
  const order = [...parts].sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1));
  const bonus = new Map<ReportSource, number>();
  for (const part of order) {
    if (left <= 0) break;
    bonus.set(part.source, 1);
    left -= 1;
  }
  return {
    totalAmount: total,
    items: parts.map((p) => ({
      source: p.source,
      amount: bySource[p.source],
      basisPoints: Number(p.floor) + (bonus.get(p.source) ?? 0),
    })),
  };
}
