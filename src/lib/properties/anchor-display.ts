import type { AnchorStatus, PropertyAnchor } from '@/lib/types';

// 物件頁「產權」區塊的顯示文字。純函式，前端可直接匯入（不要從 '@/lib/properties' 匯入：那裡有伺服器端的程式）。
// 名稱來自 registry 的參照表，已經是「臺」，這裡不再轉換。

export const ANCHOR_STATUS_LABELS: Record<AnchorStatus, string> = {
  pending_verification: '待補建號',
  keyed: '已建號',
  merged: '已合併',
  retired: '已停用',
};

/** 縣市、鄉鎮市區、段小段，以空白分隔。沒有行政區（待驗證）回 null。 */
export function anchorLocationText(anchor: PropertyAnchor | null): string | null {
  if (!anchor?.city_name || !anchor.town_name || !anchor.section_name) return null;
  return `${anchor.city_name} ${anchor.town_name} ${anchor.section_name}`;
}

/** 建號加分號，例如 `01234-000`。沒有建號回 null。 */
export function anchorKeyText(anchor: PropertyAnchor | null): string | null {
  if (!anchor?.building_no) return null;
  return `${anchor.building_no}-${anchor.sub_no ?? '000'}`;
}

/** 一行摘要，列表用。 */
export function anchorSummary(anchor: PropertyAnchor | null): string {
  const location = anchorLocationText(anchor);
  const key = anchorKeyText(anchor);
  if (!location || !key) return ANCHOR_STATUS_LABELS.pending_verification;
  return `${location} 建號 ${key}`;
}
