// E1 的六個事件與分錄模板（ADR-0015 決議 2 的表）。
// 其他線（例如 F 線的 handover_released、handover_received）用同一個 defineLedgerEvent()
// 另寫事件檔，再用 extendLedgerRegistry() 加進登錄表。不改這個檔案，也不改核心函式。

import {
  bankAccount,
  deductionIncomeAccount,
  depositAccount,
  prepaidRentAccount,
  rentIncomeAccount,
} from './accounts';
import { asRecord, readAmount, readId } from './payload';
import { createLedgerRegistry, defineLedgerEvent, type ParseResult } from './registry';
import type { JournalLine } from './types';

const dr = (account: string, amount: number): JournalLine => ({ account, debit: amount, credit: 0 });
const cr = (account: string, amount: number): JournalLine => ({ account, debit: 0, credit: amount });

function finish<P>(errors: string[], value: P): ParseResult<P> {
  return errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

/** 入帳確認。一筆入帳得同時含押金、租金與超額的預收，金額為 0 的部分不產生明細。 */
export interface ReceiptConfirmedPayload {
  paymentAccountId: string;
  deposit: number;
  rent: number;
  prepaidRent: number;
}

export const receiptConfirmed = defineLedgerEvent<ReceiptConfirmedPayload>({
  type: 'receipt_confirmed',
  label: '入帳確認',
  parsePayload(raw) {
    const errors: string[] = [];
    const source = asRecord(raw, errors);
    if (!source) return { ok: false, errors };
    const value: ReceiptConfirmedPayload = {
      paymentAccountId: readId(source, 'paymentAccountId', errors),
      deposit: readAmount(source, 'deposit', errors, { required: false }),
      rent: readAmount(source, 'rent', errors, { required: false }),
      prepaidRent: readAmount(source, 'prepaidRent', errors, { required: false }),
    };
    const total = value.deposit + value.rent + value.prepaidRent;
    if (errors.length === 0 && total === 0) errors.push('押金、租金、預收至少要有一項大於 0');
    if (errors.length === 0 && !Number.isSafeInteger(total)) errors.push('入帳金額合計超過安全整數範圍');
    return finish(errors, value);
  },
  template({ paymentAccountId, deposit, rent, prepaidRent }, { caseId }) {
    const lines: JournalLine[] = [dr(bankAccount(paymentAccountId), deposit + rent + prepaidRent)];
    if (deposit > 0) lines.push(cr(depositAccount(caseId), deposit));
    if (rent > 0) lines.push(cr(rentIncomeAccount(caseId), rent));
    if (prepaidRent > 0) lines.push(cr(prepaidRentAccount(caseId), prepaidRent));
    return lines;
  },
});

export interface AmountPayload {
  amount: number;
}

function parseAmountOnly(raw: unknown): ParseResult<AmountPayload> {
  const errors: string[] = [];
  const source = asRecord(raw, errors);
  if (!source) return { ok: false, errors };
  return finish(errors, { amount: readAmount(source, 'amount', errors, { positive: true }) });
}

/** 預收租金抵充租金。 */
export const prepaidApplied = defineLedgerEvent<AmountPayload>({
  type: 'prepaid_applied',
  label: '預收租金抵充',
  parsePayload: parseAmountOnly,
  template: ({ amount }, { caseId }) => [dr(prepaidRentAccount(caseId), amount), cr(rentIncomeAccount(caseId), amount)],
});

/** 押金扣抵。扣抵登錄時就寫分錄，異議不改分錄（ADR-0015 決議 8）。 */
export const depositDeducted = defineLedgerEvent<AmountPayload>({
  type: 'deposit_deducted',
  label: '押金扣抵',
  parsePayload: parseAmountOnly,
  template: ({ amount }, { caseId }) => [dr(depositAccount(caseId), amount), cr(deductionIncomeAccount(caseId), amount)],
});

export interface DepositReturnedPayload {
  paymentAccountId: string;
  amount: number;
}

/** 押金返還。金額是實際匯款的金額（ADR-0015 決議 10）。 */
export const depositReturned = defineLedgerEvent<DepositReturnedPayload>({
  type: 'deposit_returned',
  label: '押金返還',
  parsePayload(raw) {
    const errors: string[] = [];
    const source = asRecord(raw, errors);
    if (!source) return { ok: false, errors };
    return finish(errors, {
      paymentAccountId: readId(source, 'paymentAccountId', errors),
      amount: readAmount(source, 'amount', errors, { positive: true }),
    });
  },
  template: ({ paymentAccountId, amount }, { caseId }) => [
    dr(depositAccount(caseId), amount),
    cr(bankAccount(paymentAccountId), amount),
  ],
});

export interface FundsHandedOverPayload {
  fromPaymentAccountId: string;
  toPaymentAccountId: string;
  amount: number;
}

/** 代收交付：代管業者帳戶交付到屋主帳戶。 */
export const fundsHandedOver = defineLedgerEvent<FundsHandedOverPayload>({
  type: 'funds_handed_over',
  label: '代收交付',
  parsePayload(raw) {
    const errors: string[] = [];
    const source = asRecord(raw, errors);
    if (!source) return { ok: false, errors };
    const value: FundsHandedOverPayload = {
      fromPaymentAccountId: readId(source, 'fromPaymentAccountId', errors),
      toPaymentAccountId: readId(source, 'toPaymentAccountId', errors),
      amount: readAmount(source, 'amount', errors, { positive: true }),
    };
    if (errors.length === 0 && value.fromPaymentAccountId === value.toPaymentAccountId) {
      errors.push('交付與收受的收款帳戶不得相同');
    }
    return finish(errors, value);
  },
  template: ({ fromPaymentAccountId, toPaymentAccountId, amount }) => [
    dr(bankAccount(toPaymentAccountId), amount),
    cr(bankAccount(fromPaymentAccountId), amount),
  ],
});

export interface ReversalPayload {
  /** 原分錄的明細。沖銷分錄把每列借貸互換。 */
  lines: readonly JournalLine[];
}

/**
 * 沖銷。借貸與原分錄相反。不可直接寫入，必須經 `buildReversal()`，
 * 因為沖銷要帶原因與原分錄 ID。
 */
export const reversal = defineLedgerEvent<ReversalPayload>({
  type: 'reversal',
  label: '沖銷',
  postable: false,
  parsePayload(raw) {
    const errors: string[] = [];
    const source = asRecord(raw, errors);
    if (!source) return { ok: false, errors };
    if (!Array.isArray(source.lines)) errors.push('lines 必須是陣列');
    return finish(errors, { lines: source.lines as JournalLine[] });
  },
  template: ({ lines }) => lines.map((line) => ({ account: line.account, debit: line.credit, credit: line.debit })),
});

export const E1_LEDGER_EVENTS = [
  receiptConfirmed,
  prepaidApplied,
  depositDeducted,
  depositReturned,
  fundsHandedOver,
  reversal,
] as const;

export const E1_EVENT_TYPES = E1_LEDGER_EVENTS.map((event) => event.type);

/** E1 的登錄表。其他線用 `extendLedgerRegistry(defaultLedgerRegistry, [...])` 加事件。 */
export const defaultLedgerRegistry = createLedgerRegistry(E1_LEDGER_EVENTS);
