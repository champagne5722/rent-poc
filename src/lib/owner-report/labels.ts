// 報表上的固定文字。畫面與 CSV 共用。

import type { HolderKind } from '../deposit-rules';
import type { HandoverDelayLabel } from '../receivables';
import type { LedgerDetailType, RepairStatus, ReportNote, ReportSource } from './types';

export const IMMUTABLE_STATEMENT = '本報表產出後不可變。之後的更正會出現在下一份報表的沖銷列。';

/** 註記四條固定文字（MIL-47、ADR-0014 決議 10、ADR-0015 決議 1）。 */
export const OWNER_REPORT_NOTES: readonly ReportNote[] = [
  { key: 'bank_record', text: '金額以銀行紀錄為準。' },
  { key: 'cash_no_bank_record', text: '現金收取沒有銀行紀錄。' },
  { key: 'repair_record_only', text: '修繕費用只記錄，不進鏡像帳，系統不代收也不代付。' },
  { key: 'not_for_tax', text: '本報表不得用於報稅。' },
];

export const FLAG_OVERDUE = '逾期';
export const FLAG_REVERSED = '已被沖銷';
export const FLAG_DEPOSIT_NOT_HANDED_OVER = '押金未交付';

export function handoverFlag(label: HandoverDelayLabel): string {
  return label.key === 'over_social_housing_5_days' ? `逾 ${label.limitDays} 日` : `逾約定 ${label.agreedDays} 日`;
}

export const SOURCE_LABELS: Record<ReportSource, string> = {
  manual: '手動',
  statement_file: '對帳檔',
  cash: '現金收取',
};

/** CSV 來源欄的值。ADR-0050 決議 15：`manual`、`statement_file`、現金收取。 */
export const SOURCE_CSV_VALUES: Record<ReportSource, string> = {
  manual: 'manual',
  statement_file: 'statement_file',
  cash: '現金收取',
};

export const LEDGER_TYPE_LABELS: Record<LedgerDetailType, string> = {
  rent: '租金',
  deposit: '押金',
  prepaid_rent: '預收租金',
  reversal: '沖銷',
};

export const HOLDER_KIND_LABELS: Record<HolderKind, string> = {
  lessor: '出租人',
  owner: '屋主',
  manager: '代管業者',
  other: '其他',
};

export const FUND_KIND_LABELS = { rent: '租金', deposit: '押金' } as const;

/** 押金收款帳戶持有人的顯示文字，例如「代管業者 808-***5678」。 */
export function holderText(row: { holderKind: HolderKind | null; holderMaskedId: string | null; holderIsCash: boolean }): string {
  if (row.holderKind === null) return '';
  const parts: string[] = [HOLDER_KIND_LABELS[row.holderKind]];
  if (row.holderIsCash) parts.push('現金收取');
  else if (row.holderMaskedId !== null) parts.push(row.holderMaskedId);
  return parts.join(' ');
}

export const REPAIR_STATUS_LABELS: Record<RepairStatus, string> = {
  reported: '已報修',
  in_progress: '處理中',
  completed: '已完成',
  cancelled: '已取消',
};
