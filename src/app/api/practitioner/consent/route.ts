import { jsonError, jsonOk, readJson } from '@/lib/http';
import { recordConsentFlow } from '@/lib/practitioners';
import { requirePracticeActor } from '@/lib/practitioners/route';

// 對「證書資料個資告知」目前版本表態（MIL-111，P0-24 AC3）。同意或反對都記錄。

export async function POST(request: Request): Promise<Response> {
  const body = (await readJson(request)) as { decision?: unknown } | undefined;
  if (!body || typeof body !== 'object') return jsonError(400, '請求本文必須是 JSON');
  const gate = await requirePracticeActor('practitioner.register');
  if (!gate.ok) return gate.response;

  const result = await recordConsentFlow(gate.actor, body);
  switch (result.status) {
    case 'recorded':
      return jsonOk({ data: { decision: result.decision } }, { status: 201 });
    case 'invalid':
      return jsonError(400, '請選擇同意或反對');
    case 'forbidden':
      return jsonError(403, '只有執業主體組織的成員能表態');
  }
}
