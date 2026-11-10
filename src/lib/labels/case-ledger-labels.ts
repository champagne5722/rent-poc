// 案件帳務設定畫面的標籤（MIL-123）。純常數，畫面與測試共用。用詞以 GLOSSARY.md 為準。
// 押金持有人警告與阻擋的文字內容待法務確認（MIL-62）。這裡只寫事實與規則名稱，不寫「合法」或「違法」。

export const REMITTER_KIND_LABELS = {
  payer_name: '付款人戶名',
  account_last5: '付款帳號末五碼',
} as const;

export const DEPOSIT_LEDGER_STATUS_LABELS = {
  open: '進行中',
  settled: '已結清',
} as const;

export const PERIOD_STATE_LABELS = {
  active: '生效',
  cancelled: '已取消',
} as const;

/** 押金帳戶規則的訊息鍵對照文字（src/lib/deposit-rules/messages.ts）。待法務確認。 */
export const DEPOSIT_HOLDER_MESSAGE_TEXT: Record<string, string> = {
  'deposit_holder.block.social_housing_manager': '社宅代管案件的押金不放在代管業者的收款帳戶。',
  'deposit_holder.warn.manager_holds_deposit': '代管業者持有押金時，有公告義務。',
  'deposit_holder.warn.fix_mandate': '委託管理合約的委託範圍沒有押金管理，請先修改委託管理合約。',
  'deposit_holder.warn.rule_unmatched': '押金帳戶規則沒有命中，請確認押金持有人。',
};

export const SOCIAL_HOUSING_LABELS = {
  yes: '社宅代管案件',
  no: '非社宅代管案件',
} as const;

// 入帳確認（MIL-125）。用詞以 GLOSSARY.md 為準：入帳確認、應收期別、押金台帳、預收租金、收款帳戶持有人。
// 介面不顯示借貸，不出現「信託」字樣。

export const RECEIPT_PURPOSE_LABELS = {
  rent: '租金',
  security_deposit: '押金',
} as const;

/** 每筆入帳的來源標示。現金收取沒有銀行紀錄可比對，所以單獨標出（ADR-0014 決議 10）。 */
export function receiptSourceLabel(source: 'manual' | 'statement_file', isCash: boolean): string {
  if (isCash) return '現金收取';
  return source === 'manual' ? '使用者登錄' : '對帳檔';
}

/** 登錄入帳失敗時，route 回的 code 對應的處理提示。 */
export const RECEIPT_HOLDER_CONFIRM_NOTE = '平台只記錄款項，不經手款項。確認後，系統會記錄你已看過這項規則，並通知委託人。';
