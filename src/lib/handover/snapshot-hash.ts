// 快照雜湊（ADR-0024 決議 7）：鍵排序的 canonical JSON 計算 SHA-256。只做快照雜湊，不做 hash chain。
// 用 node:crypto，只給 server 端用。
import { createHash } from 'node:crypto';

/** 物件的鍵依 UTF-16 碼位排序，陣列保留順序，undefined 的鍵省略。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** 回傳鍵已排序的複本。移交包的 JSON 檔也用它，讓輸出不受來源的鍵順序影響。 */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}

/** 回傳 64 個字元的小寫十六進位 SHA-256。驗證時用同一個函式重算比對。 */
export function hashHandoverSnapshot(snapshot: unknown): string {
  return createHash('sha256').update(canonicalJson(snapshot), 'utf8').digest('hex');
}
