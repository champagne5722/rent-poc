import { jsonError, jsonOk, readJson } from '@/lib/http';
import { isUlid } from '@/lib/pg/ulid';
import { defaultFlowDeps } from '@/lib/practice-entities/deps';
import { requireOperator } from '@/lib/practice-entities/operator-tx';
import { recordCredentialCheckFlow } from '@/lib/practitioners';

type Ctx = { params: Promise<{ id: string }> };

// 登錄證書、任職或同意書核對（MIL-111，ADR-0017 決議 10）。只有平台營運者。項目類型決定要填的欄位。
// 證書相符：登錄 resim 的效期，影本刪除。任職相符前先判定專任，別家已有已驗證任職時回 422。
// 不符：維持待驗證，通知補件。

export async function POST(request: Request, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  const body = (await readJson(request)) as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') return jsonError(400, '請求本文必須是 JSON');
  if (!isUlid(id)) return jsonError(404, '審核項目不存在');

  const operator = await requireOperator();
  if (!operator.ok) return operator.response;

  const result = await recordCredentialCheckFlow(operator.run, id, body, defaultFlowDeps());
  switch (result.status) {
    case 'recorded':
      return jsonOk({ data: { checkId: result.checkId, from: result.from, to: result.to, result: result.result, warnings: result.warnings } });
    case 'invalid':
      return jsonError(400, result.message, { extra: { field: result.field } });
    case 'exclusivity_blocked':
      return jsonError(422, result.message, { extra: { code: 'exclusivity_blocked' } });
    case 'certificate_taken':
      return jsonError(422, result.message, { extra: { code: 'certificate_taken' } });
    case 'not_found':
      return jsonError(404, '審核項目不存在');
    case 'wrong_type':
      return jsonError(400, '這不是證書、任職或同意書核對項目');
    case 'already_resolved':
      return jsonError(409, '這個項目已結案');
    case 'conflict':
      return jsonError(409, '狀態剛被改動，請重新整理後再登錄');
  }
}
