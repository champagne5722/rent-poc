import { connection } from 'next/server';
import { resolveTransitionalContext, type RequestContext } from './request-context';

/**
 * 目前請求的脈絡。沒有登入時丟 Unauthenticated。只給 server component 與 route 用。
 * 過渡期回傳環境變數 DEFAULT_ORG_ID 指定的預設組織，沒有設定就不開放存取。
 * C 線（MIL-103）完成登入後只換這個函式的實作：改讀 session，回傳 org、party、operator 三種脈絡。
 */
export async function requestContext(): Promise<RequestContext> {
  // 環境變數要在請求時讀，不得在 build 時凍結（Cloud Run 的環境變數在執行時才注入）
  await connection();
  return resolveTransitionalContext(process.env, crypto.randomUUID());
}
