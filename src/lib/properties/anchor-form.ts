// 「產權」表單的值轉成 API 的 anchor 欄位（MIL-143）。純函式，前端可直接匯入。

export interface AnchorFormValues {
  /** 勾「暫無建號」：只靠門牌登錄，不送鍵。 */
  noKey?: boolean;
  key?: { city?: string; town?: string; section?: string; buildingNo?: string; subNo?: string };
  latitude?: number | null;
  longitude?: number | null;
}

export interface AnchorPayload {
  key: { city: string; town: string; section: string; buildingNo: string; subNo: string } | null;
  latitude: number | null;
  longitude: number | null;
}

export function buildAnchorPayload(values: AnchorFormValues | undefined): AnchorPayload {
  const key = values?.key;
  return {
    key: values?.noKey || !key
      ? null
      : {
          city: key.city ?? '',
          town: key.town ?? '',
          section: key.section ?? '',
          buildingNo: (key.buildingNo ?? '').trim(),
          subNo: (key.subNo ?? '').trim(),
        },
    latitude: values?.latitude ?? null,
    longitude: values?.longitude ?? null,
  };
}
