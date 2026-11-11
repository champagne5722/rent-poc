import { parsePropertyCreateInput, type PropertyInput } from '../properties';
import type { MandateRequestDraft } from '../types';

// 業者代填資料的驗證（MIL-206）。只做格式驗證，與登錄物件用同一份規則（parsePropertyCreateInput）。
// 這裡絕不查建號有沒有被別的組織登錄：業者代填的建號與別人已登錄的相同時，回應不得有任何差異（ADR-0028 決議 1）。
// 存進資料庫的是業者送來的原始欄位（只留已知的欄位），不是驗證後的結果。屋主確認時再驗證一次，不信任存放的值。

const DRAFT_FIELDS = ['name', 'address', 'type', 'size', 'default_rent', 'note', 'equipment', 'anchor'] as const;

export type DraftParseResult = { ok: true; draft: MandateRequestDraft | null } | { ok: false; error: string };

/** 沒給代填資料（undefined 或 null）是合法的：連結不帶代填資料，屋主從自己已登錄的租賃單位選。 */
export function parseDraft(raw: unknown): DraftParseResult {
  if (raw === undefined || raw === null) return { ok: true, draft: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: '代填資料格式有誤' };
  const picked: Record<string, unknown> = {};
  for (const field of DRAFT_FIELDS) {
    if ((raw as Record<string, unknown>)[field] !== undefined) picked[field] = (raw as Record<string, unknown>)[field];
  }
  const parsed = parsePropertyCreateInput(picked);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, draft: picked as unknown as MandateRequestDraft };
}

/** 屋主確認時：把存放的代填資料重新驗證成登錄入口的輸入。 */
export function draftToPropertyInput(draft: unknown): { ok: true; input: PropertyInput } | { ok: false; error: string } {
  const parsed = parsePropertyCreateInput(draft);
  return parsed.ok ? { ok: true, input: parsed.value } : { ok: false, error: parsed.error };
}
