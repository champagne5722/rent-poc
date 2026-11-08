// 對帳檔匯入的型別（MIL-157、ADR-0014 決議 3、6、7、8、ADR-0050 決議 6 到 8）。
// 只有型別，沒有 I/O。ID 一律 string，金額一律整數新台幣元，日期一律 YYYY-MM-DD（台灣日期）。

export type StatementEncoding = 'utf-8' | 'big5';

/** 金額欄的對應：存入與支出兩欄，或單一金額欄加正負號（正是存入、負是支出）。 */
export type AmountMapping =
  | { deposit: string; withdrawal?: string }
  | { signed: string };

/**
 * 一個收款帳戶的欄位對應（ADR-0050 決議 7）。值是 CSV 表頭的欄位名稱。
 * 表頭之前的說明列（銀行常見的帳號、查詢期間）會被略過。
 */
export interface ColumnMapping {
  transactionDate: string;
  amount: AmountMapping;
  summary?: string;
  counterpartyName?: string;
  counterpartyAccount?: string;
  /** 銀行給的交易序號，選填。 */
  transactionSerial?: string;
  /** 欄位分隔字元，預設逗號。 */
  delimiter?: ',' | '\t' | ';';
}

/** 標準列：解析成功的入帳列。出帳列不進成功列，只計入略過列數。 */
export interface StatementRow {
  /** 該列在檔案中的行號，從 1 起算，用於錯誤回報與稽核。 */
  lineNo: number;
  /** 交易日（入帳日）。 */
  transactionDate: string;
  /** 存入金額，正整數元。 */
  depositAmount: number;
  summary: string;
  counterpartyName: string;
  counterpartyAccount: string;
  /** 沒有交易序號時為 null。 */
  transactionSerial: string | null;
  /**
   * 當日同值序號：同一檔案內，交易日、存入金額、摘要都相同的入帳列，由 1 起算。
   * 沒有交易序號時用來區分同日同值的兩筆款項。
   */
  sameDaySeq: number;
}

export type ParseErrorCode =
  | 'header_not_found'
  | 'invalid_date'
  | 'invalid_amount'
  | 'amount_missing'
  | 'amount_conflict'
  | 'amount_not_integer'
  | 'amount_unsafe'
  | 'unterminated_quote';

export interface ParseError {
  /** 檔案層級的錯誤（找不到表頭）為 null。 */
  lineNo: number | null;
  code: ParseErrorCode;
  /** header_not_found 時列出缺少的欄位名稱，其他錯誤時是原始儲存格內容。 */
  detail: string;
}

export interface ParseStatementResult {
  rows: StatementRow[];
  /** 略過的出帳列數（ADR-0014 決議 8）。 */
  skippedCount: number;
  /** 空白列數，不算略過也不算錯誤。 */
  blankCount: number;
  errors: ParseError[];
}

// ---- 自動配對 ----

/** 匯款識別（GLOSSARY）：付款人戶名或付款帳號末五碼。 */
export type RemitterIdentifier =
  | { kind: 'name'; value: string }
  | { kind: 'account_last5'; value: string };

export type RentalPurpose = 'security_deposit' | 'rent';

/** 押金帳戶規則的動作（ADR-0014 決議 13），由 evaluateHolderRule 算出後傳入。 */
export type HolderRuleAction = 'allow' | 'warn' | 'warn_fix_mandate' | 'block';

export interface DepositFacts {
  /** 約定押金，整數元。 */
  expectedAmount: number;
  /** 已收押金，已扣除沖銷，整數元。 */
  receivedAmount: number;
}

interface CaseFactsBase {
  caseId: string;
  remitterIdentifiers: RemitterIdentifier[];
  /** 案件登錄的租金與押金預設收款帳戶，去掉空值。 */
  paymentAccountIds: string[];
}

/** 合約尚未完成的案件沒有押金台帳，所以沒有押金與規則資料。 */
export type CaseFacts =
  | (CaseFactsBase & { contractCompleted: false })
  | (CaseFactsBase & {
      contractCompleted: true;
      deposit: DepositFacts;
      /** 押金用途才適用。 */
      depositHolderRuleAction: HolderRuleAction;
    });

/** 既有的 manual 入帳確認，用來偵測跨來源重複。呼叫端必須排除已被標示為佐證的那些。 */
export interface ManualReceiptFact {
  id: string;
  paymentAccountId: string;
  amount: number;
  valueDate: string;
}

export interface MatchFacts {
  /** 這份對帳檔匯入的收款帳戶。 */
  importAccount: { id: string; kind: 'general' | 'cash' };
  cases: CaseFacts[];
  manualReceipts: ManualReceiptFact[];
}

/** 進待配對清單的原因鍵。 */
export type UnmatchedReason =
  | 'cash_account'
  | 'payment_account_mismatch'
  | 'no_remitter_match'
  | 'ambiguous_remitter'
  | 'contract_incomplete'
  | 'purpose_undeterminable'
  | 'deposit_rule_blocked'
  | 'possible_duplicate_manual';

export type MatchResult =
  | {
      ok: true;
      caseId: string;
      purpose: RentalPurpose;
      /** 押金用途時是該案件的押金帳戶規則動作，租金時為 allow。 */
      holderRuleAction: HolderRuleAction;
    }
  | {
      ok: false;
      /** 主要原因，等於 reasons[0]。 */
      reason: UnmatchedReason;
      /** 所有成立的原因，依 ADR-0050 決議 6 的條件順序。 */
      reasons: UnmatchedReason[];
      /** 匯款識別命中恰好一個案件時才有。 */
      caseId?: string;
      /** possible_duplicate_manual 時列出疑似的 manual 入帳確認 ID。 */
      duplicateCandidateIds?: string[];
      /** ambiguous_remitter 時列出命中的案件 ID。 */
      ambiguousCaseIds?: string[];
    };

export interface SplitPart {
  caseId: string;
  purpose: RentalPurpose;
  amount: number;
}

export type SplitFailureReason =
  | 'no_parts'
  | 'invalid_part_amount'
  | 'duplicate_case_purpose'
  | 'sum_mismatch';

export type SplitResult =
  | { ok: true }
  | { ok: false; reason: SplitFailureReason; expected: number; actual: number };
