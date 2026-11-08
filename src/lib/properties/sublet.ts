import type { PropertyType } from '@/lib/types';
import { PROPERTY_TYPES } from '@/lib/types';

// 新增分租單位的請求本文驗證（MIL-145）。純函式。

export const MAX_SUBLET_LABEL = 40;
export const MAX_SUBLET_FLOOR = 20;
export const MAX_SUBLET_NAME = 100;

export interface SubletInput {
  /** 房號或顯示名稱，只存標籤，不是單位後綴（GLOSSARY「單位後綴」）。 */
  label: string;
  floor: string | null;
  /** 物件名稱。沒給時用「來源物件名稱 加 房號」。 */
  name: string | null;
  /** 沒給時用「套房」。 */
  type: PropertyType | null;
  /** 整戶有生效中的租賃合約時，使用者已確認警告（P0-06 AC4）。 */
  confirmed: boolean;
}

export type SubletInputResult = { ok: true; value: SubletInput } | { ok: false; error: string };

const fail = (error: string): SubletInputResult => ({ ok: false, error });

export function parseSubletInput(body: unknown): SubletInputResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return fail('請求內容格式有誤');
  const { label, floor, name, type, confirmed } = body as Record<string, unknown>;

  if (typeof label !== 'string' || !label.trim()) return fail('房號為必填');
  if (label.trim().length > MAX_SUBLET_LABEL) return fail(`房號不得超過 ${MAX_SUBLET_LABEL} 個字`);
  if (floor != null && typeof floor !== 'string') return fail('樓層需為文字');
  if (typeof floor === 'string' && floor.trim().length > MAX_SUBLET_FLOOR) return fail(`樓層不得超過 ${MAX_SUBLET_FLOOR} 個字`);
  if (name != null && typeof name !== 'string') return fail('名稱需為文字');
  if (typeof name === 'string' && name.trim().length > MAX_SUBLET_NAME) return fail(`名稱不得超過 ${MAX_SUBLET_NAME} 個字`);
  if (type != null && !(PROPERTY_TYPES as readonly unknown[]).includes(type)) {
    return fail(`型態需為${PROPERTY_TYPES.join('、')}其中之一`);
  }
  if (confirmed != null && typeof confirmed !== 'boolean') return fail('確認欄位需為布林值');

  return {
    ok: true,
    value: {
      label: label.trim(),
      floor: typeof floor === 'string' && floor.trim() ? floor.trim() : null,
      name: typeof name === 'string' && name.trim() ? name.trim() : null,
      type: (type as PropertyType | null | undefined) ?? null,
      confirmed: confirmed === true,
    },
  };
}
