import { readSessionToken } from '@/lib/auth/cookie';
import { switchIdentity } from '@/lib/auth/login-flow';
import { jsonError, jsonOk, readJson } from '@/lib/http';

// 切換目前身分（MIL-106，ADR-0022 決議 6）。只能切到帳號真的有的身分。

export async function POST(request: Request): Promise<Response> {
  const body = (await readJson(request)) as { kind?: unknown; orgId?: unknown } | undefined;
  if (!body || typeof body !== 'object') return jsonError(400, '請求本文必須是 JSON');
  const result = await switchIdentity(readSessionToken(request.headers.get('cookie')), body, new Date());
  switch (result.status) {
    case 'ok':
      return jsonOk({ data: { redirectTo: result.landing } });
    case 'unauthenticated':
      return jsonError(401, '尚未登入或沒有存取權');
    case 'not_available':
      return jsonError(404, '沒有這個身分');
  }
}
