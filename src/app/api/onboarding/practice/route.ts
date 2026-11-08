import { readSessionToken } from '@/lib/auth/cookie';
import { jsonError, readJson } from '@/lib/http';
import { createPracticeOrg } from '@/lib/orgs/onboarding';
import { onboardingResponse } from '../response';

// 第一次登入選「我是經理人」（MIL-106）：建執業主體組織與待驗證的業別。
// 統編已被別的組織登錄時，改排審核台項目，回應與一般登錄完全相同，不透露別的組織。

export async function POST(request: Request): Promise<Response> {
  const body = (await readJson(request)) as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') return jsonError(400, '請求本文必須是 JSON');
  const result = await createPracticeOrg(readSessionToken(request.headers.get('cookie')), body, { now: new Date() });
  return onboardingResponse(result);
}
