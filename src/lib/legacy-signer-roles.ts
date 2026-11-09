import type { SignerRole } from './types';

// 一次性資料轉換（MIL-55、ADR-0010）：舊合約的 `signature_fields[].signer` 由 landlord、tenant 改成 party_a、party_b。
// 合約搬到 PostgreSQL 後（MIL-83），這個轉換不再有 SQLite 的合約表可跑，改由搬資料腳本（MIL-90）呼叫。
// 頁碼與座標原樣保留，也不動 updated_at，因為這不是使用者的編輯。

const LEGACY_SIGNER_ROLES = new Map<unknown, SignerRole>([
  ['landlord', 'party_a'],
  ['tenant', 'party_b'],
]);

/**
 * 回傳改寫後的 JSON 字串；不需要改寫（沒有舊值、不是合法 JSON、不是陣列）時回 null。
 * 壞資料只略過，不得擋住整批轉換。
 */
export function convertSignatureFieldsJson(stored: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  let changed = false;
  const converted = parsed.map((f) => {
    const signer = LEGACY_SIGNER_ROLES.get(f?.signer);
    if (!signer) return f;
    changed = true;
    return { ...f, signer };
  });
  return changed ? JSON.stringify(converted) : null;
}
