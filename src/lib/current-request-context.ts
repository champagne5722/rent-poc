import { cache } from 'react';
import { cookies } from 'next/headers';
import { connection } from 'next/server';
import { SESSION_COOKIE } from './auth/config';
import { resolveRequestContext } from './auth/login-flow';
import type { RequestContext } from './request-context';

// 同一個請求內（根 layout 與頁面各呼叫一次）只查一次資料庫。cache 只在 server component 的請求範圍內生效，
// route handler 與測試裡每次呼叫都是新的查詢，所以「每個請求重查成員資格」不受影響。
const loadRequestContext = cache(async (): Promise<RequestContext> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return resolveRequestContext(token, new Date(), crypto.randomUUID());
});

/**
 * 目前請求的脈絡（ADR-0022 決議 7）：讀 session cookie，查 session 與目前身分的成員資格。
 * 沒有登入、session 到期、帳號沒有身分、成員資格失效，都丟 Unauthenticated（reason 區分原因）。
 * 頁面導向登入，route 回 401。只給 server component 與 route 用。
 */
export async function requestContext(): Promise<RequestContext> {
  await connection();
  return loadRequestContext();
}
