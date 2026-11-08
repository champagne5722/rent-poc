import { sessionCookie } from '@/lib/auth/cookie';
import { loginDeps } from '@/lib/auth/deps';
import { completeLogin } from '@/lib/auth/login-flow';
import { jsonError, jsonOk, readJson } from '@/lib/http';

// 輸入驗證碼並建立 session（MIL-103）。成功時 Set-Cookie 只放隨機 token。
// 驗證碼錯誤、過期、用過、錯太多次，回應完全相同。

/** 帳號還沒有任何身分時，回到登入頁顯示說明（建組織的流程是 MIL-106）。 */
const NO_IDENTITY_REDIRECT = '/login?notice=no-identity';

export async function POST(request: Request): Promise<Response> {
  const body = (await readJson(request)) as { email?: unknown; code?: unknown } | undefined;
  if (!body || typeof body !== 'object') return jsonError(400, '請求本文必須是 JSON');

  const result = await completeLogin(body.email, body.code, loginDeps());
  if (result.status !== 'ok') return jsonError(400, '驗證碼錯誤或已失效');

  const response = jsonOk({ data: { redirectTo: result.identity ? '/' : NO_IDENTITY_REDIRECT } });
  response.headers.append('Set-Cookie', sessionCookie(result.token, result.expiresAt));
  return response;
}
