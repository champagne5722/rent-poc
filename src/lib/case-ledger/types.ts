import type { ReceivablePeriod } from '../receivables';

// 接上案件的帳務資料型別（MIL-123）。日期欄位一律是 YYYY-MM-DD 字串（台灣日期），時間欄位是 ISO 8601，金額是整數新台幣元。

/** 合約欄位中，建立押金台帳與應收期別需要的部分。取自 LeaseContractFields。 */
export interface LeaseTerms {
  /** 押金（元）。合約沒填時是 null，約定金額記為 0。 */
  deposit: number | null;
  /** 租期起日 YYYY-MM-DD。 */
  startDate: string;
  endDate: string;
  /** 每月付款日，1 到 31。 */
  payDay: number | null;
  /** 月租（元）。 */
  rent: number | null;
}

export type DepositLedgerStatus = 'open' | 'settled';

export interface DepositLedger {
  id: string;
  caseId: string;
  /** 約定金額。餘額另由鏡像帳加總，台帳不存餘額（ADR-0015 決議 6）。 */
  expectedAmount: number;
  status: DepositLedgerStatus;
  createdAt: string;
}

/** 應收期別列。未入帳、部分入帳、已入帳由配置算出（MIL-125），這裡只有生效或取消。 */
export interface PeriodRecord extends ReceivablePeriod {
  caseId: string;
  /** 每日排程判定逾期的時間（MIL-130）。 */
  overdueAt: string | null;
}

export const REMITTER_KINDS = ['payer_name', 'account_last5'] as const;
export type RemitterKind = (typeof REMITTER_KINDS)[number];

export interface RemitterId {
  id: string;
  caseId: string;
  kind: RemitterKind;
  /** 正規化後的值：戶名是 NFKC、去除前後空白、連續空白合成一個。 */
  value: string;
  createdAt: string;
}

export interface SocialHousingChange {
  id: string;
  caseId: string;
  fromValue: boolean;
  toValue: boolean;
  reason: string;
  changedByPartyId: string | null;
  changedAt: string;
}

export interface DefaultAccounts {
  rentAccountId: string | null;
  depositAccountId: string | null;
}
