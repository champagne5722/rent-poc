// 入帳確認的型別（MIL-125，ADR-0014 決議 4、7）。只有型別與常數，沒有 I/O。
// ID 一律 string，金額一律整數新台幣元，日期一律 YYYY-MM-DD（台灣日期）。

import type { DepositHolderMessageKey, HolderKind, HolderRuleAction } from '../deposit-rules';
import type { NotifyReceipt } from '../notifications';
import type { LedgerError } from './types';

/** 入帳確認的來源。Phase 1 兩種；P2 加 bank_push、escrow_push 時只加這裡與資料庫的 CHECK（ADR-0014 決議 3）。 */
export const RECEIPT_SOURCES = ['manual', 'statement_file'] as const;
export type ReceiptSource = (typeof RECEIPT_SOURCES)[number];

/** 入帳用途。識別字不用 deposit 表示入帳（ADR-0014 決議 5）。 */
export const RECEIPT_PURPOSES = ['security_deposit', 'rent'] as const;
export type ReceiptPurpose = (typeof RECEIPT_PURPOSES)[number];

/** 證明檔。檔案本體由呼叫端在交易外寫進 FileStore，這裡只收 key 與雜湊。 */
export interface ReceiptEvidence {
  /** FileStore 的 key，必須以 `org/{org_id}/ledger/receipt-evidence/` 開頭。 */
  objectKey: string;
  /** 檔案內容的 SHA-256，小寫十六進位。 */
  sha256: string;
  fileName: string;
  contentType: string;
}

/**
 * 入帳確認的候選：所有來源（人工、對帳檔、推送）都轉成這個形狀，再交給 confirmReceipt()。
 * `source` 與 `externalId` 一起決定去重（組織內唯一）。
 */
export interface ReceiptCandidate {
  source: ReceiptSource;
  /** 去重鍵。manual 是表單產生的冪等鍵，statement_file 是交易序號或列雜湊（MIL-129）。 */
  externalId: string;
  caseId: string;
  purpose: ReceiptPurpose;
  amount: number;
  /** 銀行日。 */
  valueDate: string;
  paymentAccountId: string;
  /** 登錄者。沒有人登錄（對帳檔自動配對、推送）時是 null。 */
  recordedByPartyId: string | null;
  /** 這次登錄是不是受託人代屋主操作。寫進稽核事件（authorize() 的 onBehalf）。 */
  onBehalf: boolean;
  evidence?: ReceiptEvidence | null;
  /** 使用者已看過押金帳戶規則的警告並選擇繼續。沒有警告時被忽略。 */
  acknowledgeHolderWarning?: boolean;
}

/** 押金帳戶規則的判定，給畫面顯示警告或阻擋。文字由介面層依訊息鍵提供。 */
export interface HolderRuleNotice {
  action: Exclude<HolderRuleAction, 'allow'>;
  ruleId: string | null;
  ruleVersion: number | null;
  messageKey: DepositHolderMessageKey | null;
  holderKind: HolderKind;
}

export type ConfirmReceiptFailure =
  | { code: 'invalid_input'; message: string }
  | { code: 'case_not_found' }
  /** 合約還沒全員完成，沒有押金台帳與應收期別（ADR-0050 決議 4）。 */
  | { code: 'ledger_not_open' }
  /** 押金台帳已結清，不得再收押金。 */
  | { code: 'deposit_settled' }
  /** 收款帳戶不存在、不屬於本組織，或已停用。三種回應相同。 */
  | { code: 'account_not_usable' }
  /** 押金帳戶規則是 block，不寫分錄。 */
  | { code: 'holder_blocked'; notice: HolderRuleNotice }
  /** 押金帳戶規則是 warn 或 warn_fix_mandate，使用者尚未確認。 */
  | { code: 'holder_ack_required'; notice: HolderRuleNotice }
  /** 同一個去重鍵已用在內容不同的入帳確認。 */
  | { code: 'idempotency_conflict' }
  /** 鏡像帳的檢查沒通過（純函式層）。通常代表程式有誤，錯誤清單原樣帶出。 */
  | { code: 'ledger_rejected'; errors: LedgerError[] };

export interface ReceiptAllocationView {
  periodId: string;
  periodKey: string;
  amount: number;
}

export interface ReceiptConfirmation {
  id: string;
  caseId: string;
  purpose: ReceiptPurpose;
  amount: number;
  valueDate: string;
  paymentAccountId: string;
  source: ReceiptSource;
  journalId: string;
  recordedByPartyId: string | null;
  recordedAt: string;
  /** 有附證明檔。檔案的 key 與雜湊不外露。 */
  hasEvidence: boolean;
  /** 同一份證明檔再用時，最早用它的入帳確認。 */
  evidenceReuseOf: string | null;
}

export type ConfirmReceiptResult =
  | {
      ok: true;
      /** true 表示同一個去重鍵已入帳過，這次沒有寫任何東西，回傳的是原本那筆。 */
      duplicate: boolean;
      confirmation: ReceiptConfirmation;
      /** 配到各期別的金額。押金沒有配置。 */
      allocations: ReceiptAllocationView[];
      /** 超過所有未足額期別、記為預收租金的金額。 */
      prepaid: number;
      /** 有持有人確認紀錄時的 ID。 */
      holderAcknowledgmentId: string | null;
      /** 通知委託人的單據。交易提交後，對有 outboxId 的單據呼叫 dispatchNotificationEmail。 */
      notices: NotifyReceipt[];
    }
  | { ok: false; failure: ConfirmReceiptFailure };
