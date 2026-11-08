import type { PropertyUnit } from '@/lib/types';

// 租賃單位在畫面上的文字（MIL-145）。純函式，前端可直接匯入
// （不要從 '@/lib/properties' 匯入：那裡有伺服器端的程式）。
// 房號只是標籤（GLOSSARY「單位後綴」）：分租單位沒有房號時，退而顯示後綴。

type UnitTextFields = Pick<PropertyUnit, 'unit_type' | 'suffix' | 'label'>;

/** 列表用：「整戶」或「分租 301」。 */
export function unitShortText(unit: UnitTextFields): string {
  return unit.unit_type === 'sublet' ? `分租 ${unit.label ?? unit.suffix}` : '整戶';
}

/** 詳情與單位分頁用：多帶單位後綴，例如「分租 301（後綴 0001）」。 */
export function unitFullText(unit: UnitTextFields): string {
  return `${unitShortText(unit)}（後綴 ${unit.suffix}）`;
}
