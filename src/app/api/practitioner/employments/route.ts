import { jsonError, jsonOk, readJson } from '@/lib/http';
import { createEmploymentFlow } from '@/lib/practitioners';
import { defaultFlowDeps } from '@/lib/practice-entities/deps';
import { requirePracticeActor } from '@/lib/practitioners/route';

// 換公司：證書已登錄，本人在目前執業主體建立待驗證任職（MIL-111，P0-05 AC2）。證書層的核對沿用，只核任職。

export async function POST(request: Request): Promise<Response> {
  const body = (await readJson(request)) as { certificateId?: unknown; startedOn?: unknown } | undefined;
  if (!body || typeof body !== 'object') return jsonError(400, '請求本文必須是 JSON');
  const gate = await requirePracticeActor('practitioner.register');
  if (!gate.ok) return gate.response;

  const result = await createEmploymentFlow(gate.actor, body, defaultFlowDeps());
  switch (result.status) {
    case 'created':
      return jsonOk(
        { data: { id: result.employment.employmentId, consentRequired: result.employment.consentRequired, notice: result.employment.notice } },
        { status: 201 },
      );
    case 'invalid':
      return jsonError(400, result.message, { extra: { field: result.field } });
    case 'blocked':
      return jsonError(409, result.message, { extra: { code: 'employment_blocked' } });
    case 'consent_required':
      return jsonError(409, '登錄前請先閱讀並同意證書資料個資告知', { extra: { code: 'consent_required' } });
    case 'no_certificate':
      return jsonError(404, '找不到這張證書');
    case 'entity_not_ready':
      return jsonError(409, '這個組織的執業主體還在審核中，審核完成後才能登錄任職', { extra: { code: 'entity_not_ready' } });
    case 'already_employed':
      return jsonError(409, '你在這個執業主體已有任職');
    case 'forbidden':
      return jsonError(403, '只有執業主體組織的成員能建立任職');
    case 'conflict':
      return jsonError(409, '資料剛被改動，請重新整理後再送出');
  }
}
