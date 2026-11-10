// 建號表單的值轉成 API 的 anchor 欄位（MIL-143）。純函式，前端可直接匯入。

export interface AnchorFormValues {
  key?: { city?: string; town?: string; section?: string; buildingNo?: string; subNo?: string };
  latitude?: number | null;
  longitude?: number | null;
}

export interface AnchorPayload {
  /** 登錄新物件時建號必填（ADR-0028 決議 9），表單沒填鍵時這裡是 null，由伺服器回 400。 */
  key: { city: string; town: string; section: string; buildingNo: string; subNo: string } | null;
  latitude: number | null;
  longitude: number | null;
}

export function buildAnchorPayload(values: AnchorFormValues | undefined): AnchorPayload {
  const key = values?.key;
  return {
    key: !key
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
