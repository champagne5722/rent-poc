import { PROPERTY_VERIFICATION_STATUSES, type PropertyGroup, type PropertyGroupUnit, type PropertyVerificationStatus } from '@/lib/types';
import { anchorSummary } from './anchor-display';
import { unitShortText } from './unit-display';

// 物件列表的篩選與分組輔助（MIL-177，ADR-0027 決議 5）。純函式，沒有 I/O，前端能匯入。
// 一列是一個物件（PropertyGroup），底下是租賃單位。封存的單位預設不列，整組都封存時整組不列。

export interface PropertyListFilter {
  status: PropertyVerificationStatus | 'all';
  keyword: string;
  showArchived: boolean;
}

export const EMPTY_PROPERTY_LIST_FILTER: PropertyListFilter = { status: 'all', keyword: '', showArchived: false };

export function isPropertyListFilterActive(filter: PropertyListFilter): boolean {
  return filter.status !== 'all' || filter.keyword.trim() !== '' || filter.showArchived;
}

/** 組的代表單位：id 與組相同的那一個（整戶），找不到時用第一個。物件的名稱取自它。 */
export function representativeUnit(group: PropertyGroup): PropertyGroupUnit {
  return group.units.find((u) => u.id === group.id) ?? group.units[0]!;
}

const normalize = (text: string): string => text.replace(/\s+/g, '').toLowerCase();

function groupMatches(group: PropertyGroup, keyword: string): boolean {
  const needle = normalize(keyword);
  if (!needle) return true;
  const haystack = [
    group.address,
    anchorSummary(group.anchor),
    ...group.units.flatMap((u) => [u.name, u.address, u.unit?.display_code ?? '', u.unit ? unitShortText(u.unit) : '']),
  ];
  return haystack.some((text) => normalize(text).includes(needle));
}

/** 套用封存與關鍵字，不套用狀態。回傳的組只帶可見的單位。 */
function visibleGroups(groups: readonly PropertyGroup[], filter: PropertyListFilter): PropertyGroup[] {
  const result: PropertyGroup[] = [];
  for (const group of groups) {
    const units = filter.showArchived ? group.units : group.units.filter((u) => !u.archived_at);
    if (units.length === 0) continue;
    if (!groupMatches(group, filter.keyword)) continue;
    result.push({ ...group, units });
  }
  return result;
}

/** 列表要顯示的組。順序沿用傳入的順序。 */
export function selectPropertyGroups(groups: readonly PropertyGroup[], filter: PropertyListFilter): PropertyGroup[] {
  return visibleGroups(groups, filter).filter((g) => filter.status === 'all' || g.verification_status === filter.status);
}

/** 各核對狀態的物件數。受封存與關鍵字影響，不受狀態篩選影響，讓分段選單的數字不會因為選了其中一段而歸零。 */
export function countGroupsByStatus(groups: readonly PropertyGroup[], filter: PropertyListFilter): Record<PropertyVerificationStatus, number> {
  const counts = Object.fromEntries(PROPERTY_VERIFICATION_STATUSES.map((s) => [s, 0])) as Record<PropertyVerificationStatus, number>;
  for (const group of visibleGroups(groups, filter)) counts[group.verification_status] += 1;
  return counts;
}

/** 封存的單位總數，決定要不要顯示「顯示已封存」開關。 */
export function archivedUnitCount(groups: readonly PropertyGroup[]): number {
  return groups.reduce((sum, g) => sum + g.units.filter((u) => u.archived_at).length, 0);
}
