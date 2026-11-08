// 屋主月報表的輸入與輸出型別（MIL-160，母票 MIL-134）。只有型別，沒有 I/O。
// ID 一律 string。金額一律整數新台幣元。日期一律 YYYY-MM-DD（台灣日期）。時間是含時區的 ISO 8601。
// 輸入只定義「報表需要的最小形狀」，不綁資料庫。期別、配置、分錄沿用 receivables 與 ledger 的型別。

import type { Journal } from '../ledger';
import type { BusinessType, HolderKind } from '../deposit-rules';
import type { Allocation, HandoverDelayLabel, ReceivablePeriod } from '../receivables';

// ───────── 輸入 ─────────

/** 一個租賃單位在某個產出組織下的案件。單位和案件一對一，報表以此決定屋主與組織範圍。 */
export interface ReportUnit {
  unitId: string;
  caseId: string;
  ownerId: string;
  /** 產出組織。報表單位是屋主乘產出組織乘月份。 */
  orgId: string;
  /** 門牌。 */
  address: string;
  businessType: BusinessType;
  /** 社宅代管案件：代收租金交付超過 5 日要標示「逾 5 日」。 */
  isSocialHousing: boolean;
  /** 委託管理合約約定的代收交付日數。沒有約定時為 null（ADR-0014 決議 14）。 */
  agreedHandoverDays: number | null;
}

export interface ReportPeriod extends ReceivablePeriod {
  caseId: string;
}

/** 配置。多兩個時間欄位，才能還原「月底當時」的狀態。 */
export interface ReportAllocation extends Allocation {
  /** 配置寫入的時間。晚於月底的配置不計入。 */
  postedAt: string;
  /** 配置失效（改配置或沖銷）的時間。`active` 為 true 時必須是 null。失效時間晚於月底，月底當時仍算有效。 */
  deactivatedAt: string | null;
}

export interface ReportPaymentAccount {
  paymentAccountId: string;
  holderKind: HolderKind;
  /** 遮罩識別。現金收取帳戶沒有。 */
  maskedId: string | null;
  /** 現金收取帳戶。入帳來源會算成「現金收取」。 */
  isCash: boolean;
}

/** 入帳確認。連到一筆 `receipt_confirmed` 分錄。 */
export interface ReportReceipt {
  receiptId: string;
  caseId: string;
  journalId: string;
  /** 手動登錄或對帳檔。收款帳戶是現金帳戶時，報表一律算現金收取。 */
  source: 'manual' | 'statement_file';
  note: string | null;
}

export interface ReportDepositLedger {
  caseId: string;
  /** 約定押金，`deposit_ledgers.expected_amount`。 */
  expectedAmount: number;
  /** 押金目前存放的收款帳戶。還沒收到押金時為 null。 */
  paymentAccountId: string | null;
}

/** 扣抵。金額以分錄為準，這裡只補原因與異議。 */
export interface ReportDeduction {
  deductionId: string;
  caseId: string;
  /** 對應的 `deposit_deducted` 分錄。 */
  journalId: string;
  reason: string;
  disputed: boolean;
}

export interface ReportHolderAcknowledgment {
  caseId: string;
  /** 確認者姓名或名稱。 */
  confirmedBy: string;
  confirmedAt: string;
  ruleId: string | null;
  ruleVersion: number | null;
}

export type FundKind = 'rent' | 'deposit';

/** 代收交付：代管業者代收的一筆款項，與它交給屋主的紀錄。 */
export interface ReportHandover {
  handoverId: string;
  caseId: string;
  fundKind: FundKind;
  receivedAt: string;
  amount: number;
  /** 交付日。尚未交付為 null。晚於月底的交付，報表視為月底時尚未交付。 */
  handedOverAt: string | null;
  /** 實際交付金額。有交付日時必須有。 */
  handedOverAmount: number | null;
}

export type RepairStatus = 'reported' | 'in_progress' | 'completed' | 'cancelled';

export interface ReportRepair {
  repairId: string;
  caseId: string;
  description: string;
  /** 目前狀態。 */
  status: RepairStatus;
  reportedAt: string;
  /** 完成或取消的日期。狀態是已報修或處理中時為 null。 */
  closedAt: string | null;
  /** 費用，由屋主自行支付，系統只記錄。 */
  cost: number | null;
  payer: string | null;
  handler: string | null;
}

export interface OwnerReportInput {
  units: readonly ReportUnit[];
  periods: readonly ReportPeriod[];
  allocations: readonly ReportAllocation[];
  /** 這些案件到月底為止的全部分錄，含更早月份。餘額靠它加總。 */
  journals: readonly Journal[];
  receipts: readonly ReportReceipt[];
  paymentAccounts: readonly ReportPaymentAccount[];
  depositLedgers: readonly ReportDepositLedger[];
  deductions: readonly ReportDeduction[];
  holderAcknowledgments: readonly ReportHolderAcknowledgment[];
  handovers: readonly ReportHandover[];
  repairs: readonly ReportRepair[];
}

export interface OwnerReportOptions {
  ownerId: string;
  ownerName: string;
  /** 產出組織。 */
  orgId: string;
  producerName: string;
  /** 產出者的法定稱謂（P0-01）。 */
  producerLegalTitle: string;
  reportId: string;
  /** 產生時間，含時區的 ISO 8601。由呼叫端傳入。 */
  generatedAt: string;
  /** 寬限天數，組織設定。 */
  graceDays: number;
  /** 差額說明，key 是 handoverId。代管業者產出時填寫。 */
  varianceNotes?: Readonly<Record<string, string>>;
}

// ───────── 輸出 ─────────

export type ReportSource = 'manual' | 'statement_file' | 'cash';

export interface ReportHeader {
  ownerId: string;
  ownerName: string;
  /** `YYYY-MM`。 */
  month: string;
  periodStart: string;
  periodEnd: string;
  orgId: string;
  producerName: string;
  producerLegalTitle: string;
  reportId: string;
  generatedAt: string;
  immutableStatement: string;
}

export interface ReportSummary {
  /** 本月應收租金。 */
  rentDue: number;
  /** 已入帳：配置到本月期別的金額。 */
  received: number;
  /** 月底累計逾期：全部已逾期期別的未足額金額。 */
  overdue: number;
  /** 月底預收餘額。 */
  prepaidBalance: number;
  /** 月底押金餘額。 */
  depositBalance: number;
}

export type AttentionKind = 'overdue' | 'deposit_not_handed_over' | 'handover_delay';

export interface AttentionItem {
  kind: AttentionKind;
  unitId: string;
  address: string;
  /** overdue：累計逾期金額。其餘是代收金額。 */
  amount: number;
  /** overdue：最舊逾期期別的到期日。其餘是代收日。 */
  date: string;
  /** 標示文字：「逾期」、「逾 5 日」、「逾約定 N 日」、「押金未交付」。 */
  flag: string;
  note: string;
  /** 只有 handover_delay 與 deposit_not_handed_over 有。 */
  handoverId: string | null;
}

export interface OverduePeriod {
  periodKey: string;
  dueDate: string;
  outstanding: number;
}

export interface RentRow {
  unitId: string;
  address: string;
  /** 本月期別的到期日。本月沒有期別為 null。 */
  dueDate: string | null;
  rentDue: number;
  received: number;
  overdue: number;
  overduePeriods: OverduePeriod[];
  prepaidBalance: number;
}

export interface DepositDeductionRow {
  deductionId: string;
  amount: number;
  reason: string;
  disputed: boolean;
  /** 這筆扣抵的分錄已被沖銷（月底前）。 */
  reversed: boolean;
}

export interface DepositRow {
  unitId: string;
  address: string;
  expected: number | null;
  /** 月底累計已收，已扣掉被沖銷的入帳。 */
  received: number;
  /** 本月扣抵淨額，含本月沖銷。 */
  deducted: number;
  /** 本月返還淨額，含本月沖銷。 */
  returned: number;
  balance: number;
  holderKind: HolderKind | null;
  holderMaskedId: string | null;
  holderIsCash: boolean;
  /** 確認者與約定日數。兩者都沒有時為 null。 */
  remark: string | null;
  deductions: DepositDeductionRow[];
}

export interface RepairRow {
  repairId: string;
  unitId: string;
  address: string;
  description: string;
  status: RepairStatus;
  reportedAt: string;
  closedAt: string | null;
  cost: number | null;
  payer: string | null;
  handler: string | null;
}

export interface HandoverRow {
  handoverId: string;
  unitId: string;
  address: string;
  fundKind: FundKind;
  receivedAt: string;
  amount: number;
  handedOverAt: string | null;
  handedOverAmount: number | null;
  /** 交付天數：有交付日算到交付日，否則算到月底。 */
  elapsedDays: number;
  agreedDays: number | null;
  /** 差額 = 代收金額 - 交付金額。尚未交付為 null。 */
  difference: number | null;
  differenceNote: string | null;
  label: HandoverDelayLabel | null;
  /** 標示文字，沒有逾期為 null。 */
  flag: string | null;
}

export type LedgerDetailType = 'rent' | 'deposit' | 'prepaid_rent' | 'reversal';

export interface LedgerDetailRow {
  journalId: string;
  unitId: string;
  address: string;
  type: LedgerDetailType;
  /** 入帳日，分錄的銀行日。 */
  effectiveDate: string;
  /** 登錄日，`posted_at` 的台灣日期。 */
  postedDate: string;
  /** 沖銷列是負數。 */
  amount: number;
  paymentAccountMask: string | null;
  source: ReportSource | null;
  note: string | null;
  /** 已被沖銷（月底前）。 */
  reversed: boolean;
  /** 沖銷列才有。 */
  reversesJournalId: string | null;
}

export interface SourceShare {
  source: ReportSource;
  amount: number;
  /** 百分比乘 100 的整數，例如 3333 代表 33.33%。四項合計一定是 10000，全部入帳為 0 時全是 0。 */
  basisPoints: number;
}

export interface SourceBreakdown {
  /** 本月全部入帳金額，不扣沖銷。等於入帳明細中入帳列的合計。 */
  totalAmount: number;
  items: SourceShare[];
}

export interface ReportNote {
  key: 'bank_record' | 'cash_no_bank_record' | 'repair_record_only' | 'not_for_tax';
  text: string;
}

export interface OwnerReport {
  header: ReportHeader;
  summary: ReportSummary;
  attention: AttentionItem[];
  rent: RentRow[];
  deposit: DepositRow[];
  repairs: RepairRow[];
  handovers: HandoverRow[];
  ledgerDetail: LedgerDetailRow[];
  sourceBreakdown: SourceBreakdown;
  notes: ReportNote[];
  /** 已交付但有差額、卻沒有差額說明的 handoverId。產出畫面據此要求填寫。 */
  pendingVarianceNotes: string[];
}
