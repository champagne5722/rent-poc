// 合約列表的篩選、排序與進度計算，全部是純函式（見 docs/rental-contract-signing-spec.md §6）。
// UI 只負責蒐集條件與畫畫面，判斷邏輯集中在這裡以便測試。

import type { Contract, ContractStatus } from './types';
import { CONTRACT_STATUSES } from './types';

// 最後動作時間：更新時間為主，沒有則用建立時間。
export function lastActionAt(contract: Contract): string {
  return contract.updated_at ?? contract.created_at;
}

export function countByStatus(items: Contract[]): Record<ContractStatus, number> {
  const counts = Object.fromEntries(CONTRACT_STATUSES.map((s) => [s, 0])) as Record<ContractStatus, number>;
  for (const c of items) counts[c.status] += 1;
  return counts;
}

// 物件下拉的選項來源：合約帶入的物件名稱快照，去重後排序。
export function propertyNameOptions(items: Contract[]): string[] {
  const names = new Set<string>();
  for (const c of items) {
    if (c.fields.propertyName) names.add(c.fields.propertyName);
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
}

/** 租期涵蓋區間（YYYY-MM-DD 起迄），與合約租期重疊即命中。 */
export type LeaseRange = [string, string];

export interface ContractListFilter {
  status: ContractStatus | 'all';
  propertyName: string | null;
  leaseRange: LeaseRange | null;
}

export const EMPTY_CONTRACT_LIST_FILTER: ContractListFilter = {
  status: 'all',
  propertyName: null,
  leaseRange: null,
};

// 區間重疊判定。日期是 YYYY-MM-DD，字串比較即等於時間比較。
// 租期未填的合約無從判斷涵蓋，指定區間時一律不命中。
export function overlapsLeaseRange(contract: Contract, range: LeaseRange | null): boolean {
  if (!range) return true;
  const { startDate, endDate } = contract.fields;
  if (!startDate || !endDate) return false;
  const [from, to] = range;
  return endDate >= from && startDate <= to;
}

export function matchesFilter(contract: Contract, filter: ContractListFilter): boolean {
  if (filter.status !== 'all' && contract.status !== filter.status) return false;
  if (filter.propertyName && contract.fields.propertyName !== filter.propertyName) return false;
  return overlapsLeaseRange(contract, filter.leaseRange);
}

// 進行中優先：簽署中 → 草稿 → 拒簽／撤回 → 已完成。
const WORK_PRIORITY: Record<ContractStatus, number> = {
  awaiting_tenant: 0,
  awaiting_landlord: 0,
  draft: 1,
  declined: 2,
  voided: 2,
  completed: 3,
};

// 同組內依最後動作時間新到舊；時間相同時以 id 新到舊收尾，避免排序不穩定。
export function compareByWorkPriority(a: Contract, b: Contract): number {
  return (
    WORK_PRIORITY[a.status] - WORK_PRIORITY[b.status] ||
    lastActionAt(b).localeCompare(lastActionAt(a)) ||
    b.id - a.id
  );
}

export function selectContracts(items: Contract[], filter: ContractListFilter): Contract[] {
  return items.filter((c) => matchesFilter(c, filter)).sort(compareByWorkPriority);
}

// 簽署進度三點：乙方簽 → 甲方簽 → 完成。
// 回傳「目前停在第幾點」（0-based），小於此值的點視為已完成；
// 已完成回 3（三點全亮）；簽署流程外的狀態回 null，UI 顯示「—」。
export const SIGNING_PROGRESS_LABELS = ['乙方簽', '甲方簽', '完成'] as const;

const PROGRESS_STEP: Partial<Record<ContractStatus, number>> = {
  awaiting_tenant: 0,
  awaiting_landlord: 1,
  completed: SIGNING_PROGRESS_LABELS.length,
};

export function signingProgressStep(status: ContractStatus): number | null {
  return PROGRESS_STEP[status] ?? null;
}
