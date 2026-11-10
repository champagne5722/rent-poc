// 入帳確認的公開介面（MIL-125）。其他模組從這裡匯入，不從 ./index（那裡只有純函式）。
// postJournal() 與 reverseJournal() 仍不匯出：只有本目錄的業務函式能寫分錄（post.guard.test.ts）。
// 之後的業務函式（沖銷、預收抵充、押金扣抵與返還）放在本目錄，從這個檔匯出。

export { confirmReceipt, MAX_EVIDENCE_NAME_LENGTH, MAX_EXTERNAL_ID_LENGTH } from './confirm-receipt';
export {
  findConfirmationByKey,
  getDepositCollected,
  getPrepaidBalance,
  listAllocations,
  listConfirmationAllocations,
  listPeriodViews,
  listReceipts,
  type PeriodView,
  type ReceiptListItem,
} from './receipt-reads';
export {
  RECEIPT_PURPOSES,
  RECEIPT_SOURCES,
  type ConfirmReceiptFailure,
  type ConfirmReceiptResult,
  type HolderRuleNotice,
  type ReceiptAllocationView,
  type ReceiptCandidate,
  type ReceiptConfirmation,
  type ReceiptEvidence,
  type ReceiptPurpose,
  type ReceiptSource,
} from './receipt-types';
