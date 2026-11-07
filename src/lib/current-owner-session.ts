import { connection } from 'next/server';
import { resolveOwnerSession, type OwnerSession } from './owner-session';

/**
 * 目前請求的屋主身分，沒有屋主身分時回傳 null。只給 server component 與 route 用。
 * C 線接上登入後只換這個函式的實作，呼叫端與殼層不動（MIL-94）。
 */
export async function currentOwnerSession(): Promise<OwnerSession | null> {
  // 環境變數要在請求時讀，不得在 build 時凍結（Cloud Run 的環境變數在執行時才注入）
  await connection();
  return resolveOwnerSession(process.env);
}
