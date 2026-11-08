import { readSessionToken } from '@/lib/auth/cookie';
import { jsonError, readJson } from '@/lib/http';
import { createOwnerOrg } from '@/lib/orgs/onboarding';
import { onboardingResponse } from '../response';

// 第一次登入選「我是屋主」（MIL-106）：建屋主組織，帳號是 admin，session 切到新組織。

export async function POST(request: Request): Promise<Response> {
  const body = (await readJson(request)) as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') return jsonError(400, '請求本文必須是 JSON');
  const result = await createOwnerOrg(readSessionToken(request.headers.get('cookie')), body, { now: new Date() });
  return onboardingResponse(result);
}
