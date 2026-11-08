import { describe, expect, it } from 'vitest';
import { buildJournal, type BuildJournalInput } from './journal';
import { E1_EVENT_TYPES, defaultLedgerRegistry } from './events';
import { validateJournal } from './validate';

const HEADER = {
  journalId: 'J1',
  orgId: 'ORG1',
  caseId: 'CASE1',
  eventId: 'EV1',
  postedAt: '2026-11-08T03:00:00.000Z',
  effectiveDate: '2026-11-08',
} as const;

function build(eventType: string, payload: unknown, overrides: Partial<BuildJournalInput> = {}) {
  return buildJournal(defaultLedgerRegistry, { ...HEADER, eventType, payload, ...overrides });
}

// 期望的借貸對照是從 ADR-0015 決議 2 的表手寫出來，不是從模板反推。
describe('E1 六個事件的分錄模板（ADR-0015 決議 2）', () => {
  it.each([
    [
      'receipt_confirmed，只收押金',
      'receipt_confirmed',
      { paymentAccountId: 'PAY1', deposit: 60000 },
      [
        { account: 'asset.bank.PAY1', debit: 60000, credit: 0 },
        { account: 'liability.deposit.CASE1', debit: 0, credit: 60000 },
      ],
    ],
    [
      'receipt_confirmed，只收租金',
      'receipt_confirmed',
      { paymentAccountId: 'PAY1', rent: 30000 },
      [
        { account: 'asset.bank.PAY1', debit: 30000, credit: 0 },
        { account: 'income.rent.CASE1', debit: 0, credit: 30000 },
      ],
    ],
    [
      'receipt_confirmed，租金加超額的預收',
      'receipt_confirmed',
      { paymentAccountId: 'PAY1', rent: 30000, prepaidRent: 5000 },
      [
        { account: 'asset.bank.PAY1', debit: 35000, credit: 0 },
        { account: 'income.rent.CASE1', debit: 0, credit: 30000 },
        { account: 'liability.prepaid_rent.CASE1', debit: 0, credit: 5000 },
      ],
    ],
    [
      'receipt_confirmed，押金加租金加預收一次入帳',
      'receipt_confirmed',
      { paymentAccountId: 'PAY1', deposit: 60000, rent: 30000, prepaidRent: 1 },
      [
        { account: 'asset.bank.PAY1', debit: 90001, credit: 0 },
        { account: 'liability.deposit.CASE1', debit: 0, credit: 60000 },
        { account: 'income.rent.CASE1', debit: 0, credit: 30000 },
        { account: 'liability.prepaid_rent.CASE1', debit: 0, credit: 1 },
      ],
    ],
    [
      'prepaid_applied：預收抵充租金',
      'prepaid_applied',
      { amount: 12000 },
      [
        { account: 'liability.prepaid_rent.CASE1', debit: 12000, credit: 0 },
        { account: 'income.rent.CASE1', debit: 0, credit: 12000 },
      ],
    ],
    [
      'deposit_deducted：押金扣抵',
      'deposit_deducted',
      { amount: 4500 },
      [
        { account: 'liability.deposit.CASE1', debit: 4500, credit: 0 },
        { account: 'income.deduction.CASE1', debit: 0, credit: 4500 },
      ],
    ],
    [
      'deposit_returned：押金返還',
      'deposit_returned',
      { paymentAccountId: 'PAY1', amount: 55500 },
      [
        { account: 'liability.deposit.CASE1', debit: 55500, credit: 0 },
        { account: 'asset.bank.PAY1', debit: 0, credit: 55500 },
      ],
    ],
    [
      'funds_handed_over：代管業者帳戶交付屋主帳戶',
      'funds_handed_over',
      { fromPaymentAccountId: 'AGENT1', toPaymentAccountId: 'OWNER1', amount: 28000 },
      [
        { account: 'asset.bank.OWNER1', debit: 28000, credit: 0 },
        { account: 'asset.bank.AGENT1', debit: 0, credit: 28000 },
      ],
    ],
  ])('%s', (_name, eventType, payload, expectedLines) => {
    const result = build(eventType, payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lines).toEqual(expectedLines);
    expect(result.value).toMatchObject({ ...HEADER, eventType, reversesJournalId: null, reason: null });
    expect(validateJournal(result.value).ok).toBe(true);
  });

  it('E1 事件類型清單就是票上的六個', () => {
    expect([...E1_EVENT_TYPES].sort()).toEqual(
      [
        'deposit_deducted',
        'deposit_returned',
        'funds_handed_over',
        'prepaid_applied',
        'receipt_confirmed',
        'reversal',
      ].sort(),
    );
    for (const type of E1_EVENT_TYPES) expect(defaultLedgerRegistry.get(type)).toBeDefined();
  });
});

describe('E1 事件的 payload 檢查', () => {
  it.each([
    ['receipt_confirmed 全為 0', 'receipt_confirmed', { paymentAccountId: 'PAY1' }],
    ['receipt_confirmed 缺收款帳戶', 'receipt_confirmed', { rent: 100 }],
    ['receipt_confirmed 收款帳戶 ID 含點', 'receipt_confirmed', { paymentAccountId: 'a.b', rent: 100 }],
    ['receipt_confirmed 金額為負', 'receipt_confirmed', { paymentAccountId: 'PAY1', rent: -1 }],
    ['receipt_confirmed 金額為小數', 'receipt_confirmed', { paymentAccountId: 'PAY1', rent: 1.5 }],
    [
      'receipt_confirmed 合計超過安全整數',
      'receipt_confirmed',
      { paymentAccountId: 'PAY1', rent: Number.MAX_SAFE_INTEGER, deposit: 1 },
    ],
    ['payload 不是物件', 'receipt_confirmed', 'oops'],
    ['payload 是 null', 'deposit_deducted', null],
    ['prepaid_applied 金額為 0', 'prepaid_applied', { amount: 0 }],
    ['deposit_deducted 缺金額', 'deposit_deducted', {}],
    ['deposit_returned 缺帳戶', 'deposit_returned', { amount: 100 }],
    ['funds_handed_over 兩個帳戶相同', 'funds_handed_over', { fromPaymentAccountId: 'A', toPaymentAccountId: 'A', amount: 5 }],
    ['funds_handed_over 金額不是整數', 'funds_handed_over', { fromPaymentAccountId: 'A', toPaymentAccountId: 'B', amount: 0.5 }],
  ])('%s → invalid_payload', (_name, eventType, payload) => {
    const result = build(eventType, payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain('invalid_payload');
  });
});
