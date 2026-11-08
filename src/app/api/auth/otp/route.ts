import { loginDeps } from '@/lib/auth/deps';
import { requestLoginCode } from '@/lib/auth/login-flow';
import { jsonError, jsonOk, readJson } from '@/lib/http';

// 寄登入驗證碼（MIL-103）。email 有沒有帳號，回應都相同。

export async function POST(request: Request): Promise<Response> {
  const body = (await readJson(request)) as { email?: unknown } | undefined;
  if (!body || typeof body !== 'object') return jsonError(400, '請求本文必須是 JSON');

  let result;
  try {
    result = await requestLoginCode(body.email, loginDeps());
  } catch (error) {
    console.error('[auth] 寄送驗證碼失敗', error);
    return jsonError(502, '驗證碼寄送失敗，請稍後再試');
  }
  switch (result.status) {
    case 'invalid_email':
      return jsonError(400, '請輸入正確的 email');
    case 'rate_limited':
      return jsonError(429, `寄送太頻繁，請 ${result.retryAfterSec} 秒後再試`, {
        extra: { retryAfterSec: result.retryAfterSec },
        headers: { 'Retry-After': String(result.retryAfterSec) },
      });
    case 'sent':
      return jsonOk({ data: { sent: true } });
  }
}
