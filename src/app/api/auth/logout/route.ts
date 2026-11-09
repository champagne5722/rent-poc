import { clearedSessionCookie, readSessionToken } from '@/lib/auth/cookie';
import { logout } from '@/lib/auth/login-flow';
import { jsonOk } from '@/lib/http';

// 登出（MIL-103）：刪除 session 列，清掉 cookie。沒有 cookie 或 session 已不存在也回成功。

export async function POST(request: Request): Promise<Response> {
  const token = readSessionToken(request.headers.get('cookie'));
  if (token) await logout(token);
  const response = jsonOk({ data: { loggedOut: true } });
  response.headers.append('Set-Cookie', clearedSessionCookie());
  return response;
}
