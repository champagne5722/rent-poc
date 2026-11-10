import { statusPresentation } from '@/lib/status-presentation';
import type { PropertyAnchor, PropertyVerificationStatus } from '@/lib/types';

// 物件頁建號區塊的顯示文字。純函式，前端可直接匯入（不要從 '@/lib/properties' 匯入：那裡有伺服器端的程式）。
// 名稱來自 registry 的參照表，已經是「臺」，這裡不再轉換。
// 物件的核對狀態不在這裡：它由 src/lib/status-presentation.ts 的 propertyVerification 決定，畫面用 StatusTag。

/** 縣市、鄉鎮市區、段小段，以空白分隔。沒有行政區（沒有填建號的舊資料）回 null。 */
export function anchorLocationText(anchor: PropertyAnchor | null): string | null {
  if (!anchor?.city_name || !anchor.town_name || !anchor.section_name) return null;
  return `${anchor.city_name} ${anchor.town_name} ${anchor.section_name}`;
}

/** 建號加分號，例如 `01234-000`。沒有建號回 null。 */
export function anchorKeyText(anchor: PropertyAnchor | null): string | null {
  if (!anchor?.building_no) return null;
  return `${anchor.building_no}-${anchor.sub_no ?? '000'}`;
}

/** 沒有填建號的舊資料，摘要顯示這句。 */
export const NO_KEY_TEXT = '尚未填建號';

/** 一行摘要，列表用。 */
export function anchorSummary(anchor: PropertyAnchor | null): string {
  const location = anchorLocationText(anchor);
  const key = anchorKeyText(anchor);
  if (!location || !key) return NO_KEY_TEXT;
  return `${location} 建號 ${key}`;
}

/** 登錄物件或修正建號成功後顯示的訊息。不論鍵有沒有與別的組織重複，文字都一樣（ADR-0028 決議 2）。 */
export function registeredMessage(status: PropertyVerificationStatus): string {
  return `已登錄，${statusPresentation('propertyVerification', status).label}`;
}
