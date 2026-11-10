// 審核台出租權源項目與文件比對的狀態值（MIL-201 畫面段）。純函式，沒有 I/O，前端與伺服器端都能匯入。
// 名稱與色調在 src/lib/status-presentation.ts 的狀態呈現表，這裡只決定「項目現在是哪一個值」。
// 這些值只給平台營運者的畫面用。登錄的一方看不到 held（ADR-0028 決議 1）。

export const OWNERSHIP_ITEM_STATUSES = ['pending', 'overdue', 'held', 'verified', 'failed', 'superseded'] as const;
export type OwnershipItemStatus = (typeof OWNERSHIP_ITEM_STATUSES)[number];

/** 單項文件比對的結果。pending 表示營運者還沒判定。 */
export const DOCUMENT_CHECK_RESULTS = ['pending', 'match', 'mismatch'] as const;
export type DocumentCheckResult = (typeof DOCUMENT_CHECK_RESULTS)[number];

export interface OwnershipItemFacts {
  status: 'open' | 'resolved';
  resolution: string | null;
  /** 超過 1 個工作日。 */
  overdue: boolean;
  /** 兩項都相符，但別的組織對同一個鍵已有已驗證的節點。 */
  held: boolean;
}

/**
 * 審核台出租權源項目的狀態值。已結案看結果，待處理的項目先看有沒有停住，再看有沒有逾時。
 * 結案結果不是相符或不符（例如已被取代）時回 superseded。
 */
export function ownershipItemStatus(item: OwnershipItemFacts): OwnershipItemStatus {
  if (item.status === 'resolved') {
    if (item.resolution === 'match') return 'verified';
    if (item.resolution === 'mismatch') return 'failed';
    return 'superseded';
  }
  if (item.held) return 'held';
  return item.overdue ? 'overdue' : 'pending';
}

/** 節點上的比對欄位（true、false、null）轉成狀態值。 */
export function documentCheckResult(value: boolean | null): DocumentCheckResult {
  if (value === null) return 'pending';
  return value ? 'match' : 'mismatch';
}
