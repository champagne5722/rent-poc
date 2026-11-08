// 鏡像帳模組的公開介面。只匯出純函式與型別，不碰資料庫（資料庫部分是 MIL-117）。

export {
  ACCOUNT_KINDS,
  bankAccount,
  deductionIncomeAccount,
  depositAccount,
  isValidLedgerId,
  naturalBalance,
  parseAccountCode,
  prepaidRentAccount,
  rentIncomeAccount,
  type AccountKind,
  type ParsedAccount,
  type RawBalance,
} from './accounts';
export { accountTotals } from './balances';
export {
  E1_EVENT_TYPES,
  E1_LEDGER_EVENTS,
  defaultLedgerRegistry,
  depositDeducted,
  depositReturned,
  fundsHandedOver,
  prepaidApplied,
  receiptConfirmed,
  type AmountPayload,
  type DepositReturnedPayload,
  type FundsHandedOverPayload,
  type ReceiptConfirmedPayload,
} from './events';
export { reversal, type ReversalPayload } from './reversal-event';
export { isValidEffectiveDate, isValidPostedAt } from './header';
export { buildJournal, type BuildJournalInput } from './journal';
export { asRecord, readAmount, readId } from './payload';
export {
  createLedgerRegistry,
  defineLedgerEvent,
  extendLedgerRegistry,
  type AnyLedgerEvent,
  type DefineLedgerEventInput,
  type LedgerEventDefinition,
  type LedgerRegistry,
  type ParseResult,
  type TemplateContext,
} from './registry';
export { buildReversal, type BuildReversalInput } from './reversal';
export {
  LEDGER_ERROR_CODES,
  isReversal,
  type Journal,
  type JournalHeader,
  type JournalLine,
  type LedgerError,
  type LedgerErrorCode,
  type LedgerResult,
  type OriginalJournal,
  type ReversalJournal,
} from './types';
export { validateJournal } from './validate';
