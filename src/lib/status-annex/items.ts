// 現況確認附件的固定項目清單（MIL-71、ADR-0018 決議 6）。
// 項目與狀態都是第一版的假設，待法務確認（MIL-62）。改項目時把 STATUS_ANNEX_VERSION 加一。
// 清單是程式內常數，不建資料表。E 線的點交現況要共用時，從這裡取項目與狀態定義。

import type { StatusAnnexStatus } from './types';

/** 項目清單版本。任何一項的增刪或改名時加一。 */
export const STATUS_ANNEX_VERSION = 1;

export interface StatusAnnexItemDef {
  id: string;
  label: string;
}

export const STATUS_ANNEX_ITEMS: readonly StatusAnnexItemDef[] = [
  { id: 'leak', label: '屋頂與牆面有無漏水或滲水' },
  { id: 'surface', label: '牆面、天花板與地板有無龜裂或剝落' },
  { id: 'door_window', label: '門窗與鎖具' },
  { id: 'plumbing', label: '給水、排水與衛浴設備' },
  { id: 'electric', label: '電力設備、插座與開關' },
  { id: 'gas', label: '瓦斯管線與熱水設備' },
  { id: 'fire_safety', label: '消防設備（警報器與滅火器）' },
  { id: 'equipment', label: '附屬設備運作情形（詳見設備附件）' },
  { id: 'meters', label: '水表、電表與瓦斯表' },
  { id: 'common_area', label: '公共區域、門禁與鑰匙' },
];

export const STATUS_ANNEX_STATUS_LABELS: Record<StatusAnnexStatus, string> = {
  normal: '正常',
  defect: '有瑕疵',
  not_applicable: '不適用',
};

/** 尚未填寫時的標示。 */
export const STATUS_ANNEX_UNFILLED_LABEL = '未填';

/** 備註的字數上限。限制它，附件才一定放得進獨立的一頁（pdf-status-annex.test.ts 以最長備註驗證）。 */
export const STATUS_ANNEX_NOTE_MAX = 30;
