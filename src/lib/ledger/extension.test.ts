import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bankAccount,
  depositAccount,
  prepaidRentAccount,
} from './accounts';
import { accountTotals } from './balances';
import { E1_EVENT_TYPES, defaultLedgerRegistry, receiptConfirmed } from './events';
import { buildJournal } from './journal';
import { asRecord, readAmount, readId } from './payload';
import { createLedgerRegistry, defineLedgerEvent, extendLedgerRegistry } from './registry';
import { buildReversal } from './reversal';
import type { JournalLine } from './types';
import { validateJournal } from './validate';

const HEADER = {
  journalId: 'J1',
  orgId: 'ORG1',
  caseId: 'CASE1',
  eventId: 'EV1',
  postedAt: '2026-11-08T03:00:00.000Z',
  effectiveDate: '2026-11-08',
} as const;

// 測試用的擴充事件 1：E1 完全沒有的新事件類型與新科目。
const lateFeeCharged = defineLedgerEvent<{ amount: number }>({
  type: 'test_late_fee_charged',
  label: '測試用違約金',
  parsePayload(raw) {
    const errors: string[] = [];
    const source = asRecord(raw, errors);
    if (!source) return { ok: false, errors };
    const amount = readAmount(source, 'amount', errors, { positive: true });
    return errors.length === 0 ? { ok: true, value: { amount } } : { ok: false, errors };
  },
  template: ({ amount }, { caseId }) => [
    { account: depositAccount(caseId), debit: amount, credit: 0 },
    { account: `income.late_fee.${caseId}`, debit: 0, credit: amount },
  ],
});

// 測試用的擴充事件 2：ADR-0024 決議 9 的形狀。借方兩列（押金與預收），貸方一列（舊收款帳戶）。
// 這是 F 線之後要用同一個介面加的 handover_released，這裡用不同名稱，只證明介面裝得下。
const handoverReleasedShape = defineLedgerEvent<{ paymentAccountId: string; deposit: number; prepaidRent: number }>({
  type: 'test_handover_released_shape',
  label: '測試用移交交出側',
  parsePayload(raw) {
    const errors: string[] = [];
    const source = asRecord(raw, errors);
    if (!source) return { ok: false, errors };
    const value = {
      paymentAccountId: readId(source, 'paymentAccountId', errors),
      deposit: readAmount(source, 'deposit', errors),
      prepaidRent: readAmount(source, 'prepaidRent', errors),
    };
    return errors.length === 0 ? { ok: true, value } : { ok: false, errors };
  },
  template: ({ paymentAccountId, deposit, prepaidRent }, { caseId }) => {
    const lines: JournalLine[] = [];
    if (deposit > 0) lines.push({ account: depositAccount(caseId), debit: deposit, credit: 0 });
    if (prepaidRent > 0) lines.push({ account: prepaidRentAccount(caseId), debit: prepaidRent, credit: 0 });
    lines.push({ account: bankAccount(paymentAccountId), debit: 0, credit: deposit + prepaidRent });
    return lines;
  },
});

const extended = extendLedgerRegistry(defaultLedgerRegistry, [lateFeeCharged, handoverReleasedShape]);

describe('擴充事件：其他線只加事件定義，不改核心函式', () => {
  it('新事件經 buildJournal 產生平衡的分錄', () => {
    const result = buildJournal(extended, { ...HEADER, eventType: 'test_late_fee_charged', payload: { amount: 800 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lines).toEqual([
      { account: 'liability.deposit.CASE1', debit: 800, credit: 0 },
      { account: 'income.late_fee.CASE1', debit: 0, credit: 800 },
    ]);
    expect(validateJournal(result.value).ok).toBe(true);
  });

  it('移交形狀（借方兩列、貸方一列）也裝得下，且可用 buildReversal 沖銷', () => {
    const result = buildJournal(extended, {
      ...HEADER,
      eventType: 'test_handover_released_shape',
      payload: { paymentAccountId: 'OLDPAY', deposit: 60000, prepaidRent: 3000 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lines).toEqual([
      { account: 'liability.deposit.CASE1', debit: 60000, credit: 0 },
      { account: 'liability.prepaid_rent.CASE1', debit: 3000, credit: 0 },
      { account: 'asset.bank.OLDPAY', debit: 0, credit: 63000 },
    ]);

    const reversed = buildReversal(result.value, {
      journalId: 'J2',
      eventId: 'EV2',
      reason: '測試沖銷',
      postedAt: '2026-11-09T00:00:00.000Z',
      effectiveDate: '2026-11-09',
    });
    expect(reversed.ok).toBe(true);
    if (!reversed.ok) return;
    const totals = accountTotals([result.value, reversed.value]);
    for (const total of totals.values()) expect(total.debit).toBe(total.credit);
  });

  it('新事件的 payload 錯誤由它自己的 parsePayload 回報', () => {
    const result = buildJournal(extended, { ...HEADER, eventType: 'test_late_fee_charged', payload: { amount: 0 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.code)).toEqual(['invalid_payload']);
  });

  it('擴充後的登錄表保留 E1 事件，原本的登錄表不受影響', () => {
    expect(extended.types()).toEqual(expect.arrayContaining([...E1_EVENT_TYPES, 'test_late_fee_charged']));
    expect(defaultLedgerRegistry.get('test_late_fee_charged')).toBeUndefined();
    const result = buildJournal(defaultLedgerRegistry, { ...HEADER, eventType: 'test_late_fee_charged', payload: { amount: 1 } });
    expect(result.ok).toBe(false);
  });

  it('事件類型重複登錄時丟錯', () => {
    expect(() => extendLedgerRegistry(defaultLedgerRegistry, [receiptConfirmed])).toThrow(RangeError);
    expect(() => createLedgerRegistry([lateFeeCharged, lateFeeCharged])).toThrow(RangeError);
  });

  it('事件類型字串不合法時丟錯', () => {
    for (const type of ['', 'Upper', '1abc', 'has space', 'a-b']) {
      expect(() =>
        defineLedgerEvent({ type, label: 'x', parsePayload: () => ({ ok: true, value: null }), template: () => [] }),
      ).toThrow(RangeError);
    }
  });
});

describe('核心函式沒有依事件類型分支', () => {
  it('同一個模板換一個事件名稱登錄，產生一模一樣的明細', () => {
    const renamed = defineLedgerEvent({
      type: 'renamed_receipt_for_test',
      label: receiptConfirmed.label,
      parsePayload: receiptConfirmed.parsePayload,
      template: receiptConfirmed.template,
    });
    const registry = createLedgerRegistry([renamed]);
    const payload = { paymentAccountId: 'PAY1', deposit: 100, rent: 200, prepaidRent: 3 };
    const viaOriginal = buildJournal(defaultLedgerRegistry, { ...HEADER, eventType: 'receipt_confirmed', payload });
    const viaRenamed = buildJournal(registry, { ...HEADER, eventType: 'renamed_receipt_for_test', payload });
    expect(viaOriginal.ok && viaRenamed.ok).toBe(true);
    if (viaOriginal.ok && viaRenamed.ok) {
      expect(viaRenamed.value.lines).toEqual(viaOriginal.value.lines);
      expect({ ...viaRenamed.value, eventType: '' }).toEqual({ ...viaOriginal.value, eventType: '' });
    }
  });

  it('沖銷不看原分錄的事件類型：任意事件類型字串都能沖銷', () => {
    const original = buildJournal(extended, { ...HEADER, eventType: 'test_late_fee_charged', payload: { amount: 5 } });
    expect(original.ok).toBe(true);
    if (!original.ok) return;
    const result = buildReversal(
      { ...original.value, eventType: 'some_event_nobody_registered' },
      { journalId: 'J2', eventId: 'EV2', reason: 'x', postedAt: HEADER.postedAt, effectiveDate: HEADER.effectiveDate },
    );
    expect(result.ok).toBe(true);
  });

  it('原始碼守門：核心檔案不得出現 E1 事件類型的字串常值', () => {
    const coreFiles = ['accounts.ts', 'balances.ts', 'header.ts', 'journal.ts', 'payload.ts', 'registry.ts', 'reversal.ts', 'validate.ts'];
    const literal = new RegExp(`['"](${E1_EVENT_TYPES.join('|')})['"]`);
    // 不管比對哪個字串，只要對 eventType 做相等比較、switch 或 case，就是在依事件類型分支。
    const branching = /eventType\s*[!=]==?|switch\s*\(|\bcase\s+['"`]|\.type\s*[!=]==?/;
    for (const file of coreFiles) {
      const source = readFileSync(join(__dirname, file), 'utf8');
      expect(source, `${file} 不得寫死事件類型`).not.toMatch(literal);
      expect(source, `${file} 不得依事件類型分支`).not.toMatch(branching);
    }
  });
});
