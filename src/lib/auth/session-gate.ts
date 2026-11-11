import { isPublicPath } from '../demo-access';
import { isAuthScreen } from './auth-screens';

// 全站的登入閘門（MIL-103）。proxy 只做樂觀檢查：沒有 session cookie 就擋下。
// 這不是授權。cookie 存在不代表 session 有效，真正的驗證在 requestContext() 與根 layout
// （Next 官方 authentication 指南的做法：proxy 做樂觀檢查，資料存取層才做完整檢查）。
// 各 route 的授權在 route 內的 authorize()（MIL-108），這一層只擋沒有登入的請求。

/** 不需要 session 的路徑：登入頁與登入 API、demo 驗證碼頁，加上 demo-access 已列的 health 與 webhook。 */
const EXEMPT_API = new Set(['/api/auth/otp', '/api/auth/verify', '/api/auth/logout']);

// 申請連結（MIL-206）：屋主掃 QR code 或點連結時還沒有登入。連結頁的資料 API 與頁面本身登入前就要能開。
// 碼固定 43 個字元（base64url）。只放行讀取連結頁的路徑；綁定（.../claim）要 session，仍被擋。
const REQUEST_LINK_API = /^\/api\/mandate-requests\/link\/[A-Za-z0-9_-]{43}$/;
const REQUEST_LINK_PAGE = /^\/request\/[A-Za-z0-9_-]{43}$/;

export function isSessionExemptPath(pathname: string): boolean {
  return isAuthScreen(pathname) || EXEMPT_API.has(pathname) || isPublicPath(pathname) || REQUEST_LINK_API.test(pathname) || REQUEST_LINK_PAGE.test(pathname);
}

export type SessionGate = 'allow' | 'redirect_login' | 'unauthorized';

export function decideSessionGate(input: { pathname: string; hasSessionCookie: boolean }): SessionGate {
  if (isSessionExemptPath(input.pathname) || input.hasSessionCookie) return 'allow';
  return input.pathname.startsWith('/api/') ? 'unauthorized' : 'redirect_login';
}
