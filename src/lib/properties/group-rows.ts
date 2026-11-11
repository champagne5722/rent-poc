import type { Property, PropertyGroup } from '@/lib/types';

/**
 * 把依物件分組的資料攤平成一列一個租賃單位（MIL-202）。給還沒改成「一列一個物件」的畫面用，
 * 列的欄位與順序和 GET /api/properties 的扁平列表相同：新的在前。列法的改動屬於 MIL-177。
 * 純函式，沒有 I/O，前端能匯入。
 */
export function flattenPropertyGroups(groups: readonly PropertyGroup[]): Property[] {
  return groups
    .flatMap((group) => group.units.map((unit): Property => ({ ...unit, anchor: group.anchor, verification_status: group.verification_status })))
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}
