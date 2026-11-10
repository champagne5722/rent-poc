import type { AnchorKey, AnchorKeyInput } from '@/lib/registry/section-code';
import { normalizeAnchorKey } from '@/lib/registry/section-code';
import { SECTION_CODE_SEED } from '@/lib/registry/section-code/seed-data';

// 物件的建號輸入（MIL-143）。請求本文的驗證與鍵正規化，純函式，建立與補建號共用。

/** 建立物件時的建號輸入。key 為 null 表示沒有給鍵：登錄新物件時由 parsePropertyCreateInput 擋下，修改物件時不使用。 */
export interface AnchorInput {
  key: AnchorKey | null;
  latitude: number | null;
  longitude: number | null;
}

export type AnchorKeyParseResult = { ok: true; value: AnchorKey } | { ok: false; error: string };
export type AnchorInputParseResult = { ok: true; value: AnchorInput } | { ok: false; error: string };

const KEY_FIELDS = ['city', 'town', 'section', 'buildingNo', 'subNo'] as const;

/** 驗證並正規化使用者填的鍵。所有欄位的錯誤一次回傳。 */
export function parseAnchorKey(raw: unknown): AnchorKeyParseResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: '建號欄位格式有誤' };
  const record = raw as Record<string, unknown>;
  for (const field of KEY_FIELDS) {
    const value = record[field];
    if (value != null && typeof value !== 'string') return { ok: false, error: '建號欄位必須是文字' };
  }
  const input: AnchorKeyInput = {
    city: (record.city as string | undefined) ?? '',
    town: (record.town as string | undefined) ?? '',
    section: (record.section as string | undefined) ?? '',
    buildingNo: (record.buildingNo as string | undefined) ?? '',
    subNo: (record.subNo as string | undefined) ?? '',
  };
  const result = normalizeAnchorKey(SECTION_CODE_SEED, input);
  if (!result.ok) return { ok: false, error: result.errors.map((e) => e.message).join('；') };
  return { ok: true, value: result.key };
}

const isCoordinate = (value: unknown, limit: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;

/** 驗證建立物件時的 anchor 欄位。沒給（undefined）視為沒有鍵、沒有座標。 */
export function parseAnchorInput(raw: unknown): AnchorInputParseResult {
  if (raw == null) return { ok: true, value: { key: null, latitude: null, longitude: null } };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: '建號欄位格式有誤' };
  const { key, latitude, longitude } = raw as Record<string, unknown>;

  let parsedKey: AnchorKey | null = null;
  if (key != null) {
    const result = parseAnchorKey(key);
    if (!result.ok) return result;
    parsedKey = result.value;
  }

  if ((latitude == null) !== (longitude == null)) return { ok: false, error: '座標必須同時填緯度與經度' };
  if (latitude != null && (!isCoordinate(latitude, 90) || !isCoordinate(longitude, 180))) {
    return { ok: false, error: '緯度必須在 -90 到 90 之間，經度必須在 -180 到 180 之間' };
  }
  return {
    ok: true,
    value: { key: parsedKey, latitude: (latitude as number | undefined) ?? null, longitude: (longitude as number | undefined) ?? null },
  };
}
