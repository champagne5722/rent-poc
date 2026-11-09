import { SESSION_COOKIE } from './config';

// session cookie 的產生（ADR-0022 決議 2）：只放隨機 token，HttpOnly、Secure、SameSite=Lax。
// 自己組 Set-Cookie 字串，route 用 Headers.append 加上去，屬性一目了然，測試也不需要 Next 的 cookie store。

type Env = Readonly<Record<string, string | undefined>>;

// 本機開發（next dev）走 http://localhost，Safari 不收 http 上的 Secure cookie，所以只有 development 例外。
// 測試與正式環境一律 Secure。
function secureAttribute(env: Env): string {
  return env.NODE_ENV === 'development' ? '' : '; Secure';
}

export function sessionCookie(token: string, expiresAt: Date, env: Env = process.env): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${expiresAt.toUTCString()}${secureAttribute(env)}`;
}

/** 登出時清掉 cookie：同樣的屬性，值為空，立即到期。 */
export function clearedSessionCookie(env: Env = process.env): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0${secureAttribute(env)}`;
}

/** 從 Cookie 請求標頭取出 session token，沒有回傳 undefined。 */
export function readSessionToken(cookieHeader: string | null | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      const value = part.slice(eq + 1).trim();
      return value === '' ? undefined : value;
    }
  }
  return undefined;
}
