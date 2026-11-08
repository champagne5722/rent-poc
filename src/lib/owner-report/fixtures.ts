// 測試用的資料建構函式。分錄一律經 ledger 的 buildJournal 與 buildReversal 產生，
// 這樣測試資料本身就符合鏡像帳的規則。只給 *.test.ts 用，不從 index.ts 匯出。

import {
  buildJournal,
  buildReversal,
  defaultLedgerRegistry,
  type Journal,
  type OriginalJournal,
  type ReversalJournal,
} from '../ledger';
import type {
  OwnerReportInput,
  OwnerReportOptions,
  ReportAllocation,
  ReportPaymentAccount,
  ReportPeriod,
  ReportReceipt,
  ReportUnit,
} from './types';

export const ORG = 'ORG_1';
export const OWNER_A = 'OWNER_A';
export const OWNER_B = 'OWNER_B';

export const ACC_BANK = 'PAY_BANK';
export const ACC_MGR = 'PAY_MGR';
export const ACC_CASH = 'PAY_CASH';
export const ACC_OWNER = 'PAY_OWNER';

export function unit(over: Partial<ReportUnit> & Pick<ReportUnit, 'unitId' | 'caseId'>): ReportUnit {
  return {
    ownerId: OWNER_A,
    orgId: ORG,
    address: `${over.unitId} 路 1 號`,
    businessType: 'managed',
    isSocialHousing: false,
    agreedHandoverDays: 3,
    ...over,
  };
}

export const paymentAccounts: ReportPaymentAccount[] = [
  { paymentAccountId: ACC_BANK, holderKind: 'lessor', maskedId: '012-***1234', isCash: false },
  { paymentAccountId: ACC_MGR, holderKind: 'manager', maskedId: '808-***5678', isCash: false },
  { paymentAccountId: ACC_CASH, holderKind: 'manager', maskedId: null, isCash: true },
  { paymentAccountId: ACC_OWNER, holderKind: 'owner', maskedId: '700-***0001', isCash: false },
];

export function period(
  over: Partial<ReportPeriod> & Pick<ReportPeriod, 'id' | 'caseId' | 'periodKey'>,
): ReportPeriod {
  const [y, m] = over.periodKey.split('-');
  return {
    periodStart: `${y}-${m}-01`,
    periodEnd: `${y}-${m}-28`,
    dueDate: `${y}-${m}-05`,
    amount: 20000,
    kind: 'rent',
    state: 'active',
    ...over,
  };
}

export function allocation(
  over: Partial<ReportAllocation> & Pick<ReportAllocation, 'id' | 'periodId' | 'postedAt'>,
): ReportAllocation {
  return {
    sourceId: `SRC_${over.id}`,
    amount: 20000,
    source: 'receipt',
    kind: 'rent',
    active: true,
    deactivatedAt: null,
    ...over,
  };
}

interface JournalBase {
  journalId: string;
  caseId: string;
  postedAt: string;
  effectiveDate?: string;
  orgId?: string;
}

function ok(result: ReturnType<typeof buildJournal>): OriginalJournal {
  if (!result.ok) throw new Error(`fixture 分錄不合法：${JSON.stringify(result.errors)}`);
  return result.value;
}

function header(base: JournalBase) {
  return {
    journalId: base.journalId,
    orgId: base.orgId ?? ORG,
    caseId: base.caseId,
    eventId: `EVT_${base.journalId}`,
    postedAt: base.postedAt,
    effectiveDate: base.effectiveDate ?? base.postedAt.slice(0, 10),
  };
}

export function receiptJournal(
  base: JournalBase & { accountId?: string; deposit?: number; rent?: number; prepaidRent?: number },
): OriginalJournal {
  return ok(
    buildJournal(defaultLedgerRegistry, {
      ...header(base),
      eventType: 'receipt_confirmed',
      payload: {
        paymentAccountId: base.accountId ?? ACC_BANK,
        deposit: base.deposit ?? 0,
        rent: base.rent ?? 0,
        prepaidRent: base.prepaidRent ?? 0,
      },
    }),
  );
}

export function deductionJournal(base: JournalBase & { amount: number }): OriginalJournal {
  return ok(
    buildJournal(defaultLedgerRegistry, { ...header(base), eventType: 'deposit_deducted', payload: { amount: base.amount } }),
  );
}

export function returnJournal(base: JournalBase & { amount: number; accountId?: string }): OriginalJournal {
  return ok(
    buildJournal(defaultLedgerRegistry, {
      ...header(base),
      eventType: 'deposit_returned',
      payload: { paymentAccountId: base.accountId ?? ACC_BANK, amount: base.amount },
    }),
  );
}

export function handoverJournal(
  base: JournalBase & { amount: number; from?: string; to?: string },
): OriginalJournal {
  return ok(
    buildJournal(defaultLedgerRegistry, {
      ...header(base),
      eventType: 'funds_handed_over',
      payload: { fromPaymentAccountId: base.from ?? ACC_MGR, toPaymentAccountId: base.to ?? ACC_OWNER, amount: base.amount },
    }),
  );
}

export function reverse(
  original: OriginalJournal,
  over: { journalId: string; postedAt: string; reason?: string; effectiveDate?: string },
): ReversalJournal {
  const result = buildReversal(original, {
    journalId: over.journalId,
    eventId: `EVT_${over.journalId}`,
    reason: over.reason ?? '登錄錯誤',
    postedAt: over.postedAt,
    effectiveDate: over.effectiveDate ?? over.postedAt.slice(0, 10),
  });
  if (!result.ok) throw new Error(`fixture 沖銷不合法：${JSON.stringify(result.errors)}`);
  return result.value;
}

export function receiptRecord(over: Partial<ReportReceipt> & Pick<ReportReceipt, 'journalId' | 'caseId'>): ReportReceipt {
  return { receiptId: `RCPT_${over.journalId}`, source: 'manual', note: null, ...over };
}

export function emptyInput(): OwnerReportInput {
  return {
    units: [],
    periods: [],
    allocations: [],
    journals: [],
    receipts: [],
    paymentAccounts,
    depositLedgers: [],
    deductions: [],
    holderAcknowledgments: [],
    handovers: [],
    repairs: [],
  };
}

export function options(over: Partial<OwnerReportOptions> = {}): OwnerReportOptions {
  return {
    ownerId: OWNER_A,
    ownerName: '王大明',
    orgId: ORG,
    producerName: '好管家代管股份有限公司',
    producerLegalTitle: '租賃住宅管理業',
    reportId: 'RPT_2026_10_A',
    generatedAt: '2026-11-02T09:00:00+08:00',
    graceDays: 3,
    ...over,
  };
}

/** 測試裡從 `Journal[]` 取出一般分錄來沖銷。拿到沖銷分錄時丟錯。 */
export function asOriginal(journal: Journal): OriginalJournal {
  if (journal.reversesJournalId !== null) throw new Error(`fixture：${journal.journalId} 是沖銷分錄`);
  return journal;
}

export type { Journal };
