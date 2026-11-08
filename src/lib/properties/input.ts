import { parseEquipmentPayload } from '@/lib/equipment';
import type { EquipmentItem, PropertyType } from '@/lib/types';
import { PROPERTY_TYPES } from '@/lib/types';

// 物件的請求本文驗證。純函式，建立與修改共用同一份規則。

export interface PropertyInput {
  name: string;
  address: string;
  /** 沒給時，建立用「整層住家」，修改保留原值。 */
  type?: PropertyType;
  size: number | null;
  default_rent: number | null;
  note: string;
  equipment: EquipmentItem[];
}

// default_rent 欄位是 PostgreSQL integer，超過上限會變成 500，所以在這裡擋
export const MAX_DEFAULT_RENT = 2_147_483_647;

export type PropertyInputResult = { ok: true; value: PropertyInput } | { ok: false; error: string };

const fail = (error: string): PropertyInputResult => ({ ok: false, error });

export function parsePropertyInput(body: unknown): PropertyInputResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return fail('請求內容格式有誤');
  const { name, address, type, size, default_rent, note, equipment } = body as Record<string, unknown>;

  if (typeof name !== 'string' || !name.trim() || typeof address !== 'string' || !address.trim()) {
    return fail('名稱與地址為必填');
  }
  const items = parseEquipmentPayload(equipment);
  if (!items) return fail('設備清單格式有誤：每項需有名稱且數量為正整數，且不可重複');

  if (type != null && !(PROPERTY_TYPES as readonly unknown[]).includes(type)) {
    return fail(`型態需為${PROPERTY_TYPES.join('、')}其中之一`);
  }
  if (size != null && !(typeof size === 'number' && Number.isFinite(size) && size >= 0)) {
    return fail('坪數需為不小於 0 的數字');
  }
  if (
    default_rent != null &&
    !(typeof default_rent === 'number' && Number.isInteger(default_rent) && default_rent >= 0 && default_rent <= MAX_DEFAULT_RENT)
  ) {
    return fail('預設租金需為不小於 0 的整數');
  }
  if (note != null && typeof note !== 'string') return fail('備註需為文字');

  return {
    ok: true,
    value: {
      name: name.trim(),
      address: address.trim(),
      type: (type as PropertyType | null | undefined) ?? undefined,
      size: (size as number | null | undefined) ?? null,
      default_rent: (default_rent as number | null | undefined) ?? null,
      note: (note as string | null | undefined) ?? '',
      equipment: items,
    },
  };
}
