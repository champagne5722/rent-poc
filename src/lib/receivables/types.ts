// 應收期別的型別（MIL-155、ADR-0015 決議 11、ADR-0050 決議 5）。
// 只有型別，沒有 I/O。ID 一律 string，金額一律整數新台幣元，日期一律 YYYY-MM-DD（台灣日期）。

/** 資金種類。押金不進應收期別，租金與押金在型別上就分開（ADR-0050 決議 3）。 */
export type FundKind = 'rent' | 'deposit';

/** 期別狀態只有生效與取消兩種。未入帳、部分入帳、已入帳由配置算出，不存。 */
export type PeriodState = 'active' | 'cancelled';

/** 期別草稿：splitPeriods 的輸出。id 由呼叫端指派（ULID），純函式不產生 id。 */
export interface PeriodDraft {
  /** 日曆月，格式 YYYY-MM。一個月一期。 */
  periodKey: string;
  /** 該期涵蓋的第一天，含。首期可能晚於該月 1 日。 */
  periodStart: string;
  /** 該期涵蓋的最後一天，含。末期可能早於該月月底。 */
  periodEnd: string;
  /** 到期日：該月付款日，該月沒有那天時取月底。首期取付款日與期別起日較晚者。 */
  dueDate: string;
  /** 該期應收金額，整數元。首末期不足一個月時依日數比例。 */
  amount: number;
  kind: 'rent';
}

export interface ReceivablePeriod extends PeriodDraft {
  id: string;
  state: PeriodState;
}

/** 租賃合約中和期別切分有關的欄位。 */
export interface PeriodContract {
  /** 租期起日，含。 */
  startDate: string;
  /** 租期迄日，含。 */
  endDate: string;
  /** 每月付款日，1 到 31。 */
  paymentDay: number;
  /** 月租，整數元。 */
  monthlyRent: number;
}

/** 配置草稿：尚未寫入的配置。kind 固定 rent，押金不得配置到期別。 */
export interface AllocationDraft {
  /** 來源 ID。receipt：入帳確認 ID。prepaid：預收抵充事件 ID（`prepaid_applied` 的業務事件 ID）。 */
  sourceId: string;
  periodId: string;
  amount: number;
  /** receipt：入帳確認配置。prepaid：以預收抵充（`prepaid_applied`）。 */
  source: 'receipt' | 'prepaid';
  kind: 'rent';
}

export interface Allocation extends AllocationDraft {
  id: string;
  /** false 表示已被改配置或沖銷而失效。失效的配置不計入期別狀態。 */
  active: boolean;
}

/** 期別狀態。cancelled 是期別本身的狀態，其餘三種由有效配置加總算出。 */
export type PeriodStatus = 'unpaid' | 'partial' | 'paid' | 'cancelled';
