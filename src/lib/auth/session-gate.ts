import { isPublicPath } from '../demo-access';
import { isAuthScreen } from './auth-screens';

// 全站的登入閘門（MIL-103）。proxy 只做樂觀檢查：沒有 session cookie 就擋下。
// 這不是授權。cookie 存在不代表 session 有效，真正的驗證在 requestContext() 與根 layout
// （Next 官方 authentication 指南的做法：proxy 做樂觀檢查，資料存取層才做完整檢查）。
// 既有的 SQLite 合約 API 目前只有這一層，逐 route 的授權要到 MIL-108 的 authorize()。

/** 不需要 session 的路徑：登入頁與登入 API、demo 驗證碼頁，加上 demo-access 已列的 health 與 webhook。 */
const EXEMPT_API = new Set(['/api/auth/otp', '/api/auth/verify', '/api/auth/logout']);

export function isSessionExemptPath(pathname: string): boolean {
  return isAuthScreen(pathname) || EXEMPT_API.has(pathname) || isPublicPath(pathname);
}

export type SessionGate = 'allow' | 'redirect_login' | 'unauthorized';

export function decideSessionGate(input: { pathname: string; hasSessionCookie: boolean }): SessionGate {
  if (isSessionExemptPath(input.pathname) || input.hasSessionCookie) return 'allow';
  return input.pathname.startsWith('/api/') ? 'unauthorized' : 'redirect_login';
}
