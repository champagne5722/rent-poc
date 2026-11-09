import { jsonError, jsonOk, readJson } from '@/lib/http';
import { isUlid } from '@/lib/pg/ulid';
import { resolveClaimFlow } from '@/lib/practice-entities';
import { defaultFlowDeps } from '@/lib/practice-entities/deps';
import { requireOperator } from '@/lib/practice-entities/operator-tx';

type Ctx = { params: Promise<{ id: string }> };

// 判定認領同一統編的歸屬（MIL-109，ADR-0017 決議 11）。只有平台營運者。
// decision：keep_registrant 維持原登錄者，to_claimant 改歸認領方（執業主體沒有已驗證業別時才允許）。

export async function POST(request: Request, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  const body = (await readJson(request)) as { decision?: unknown; note?: unknown } | undefined;
  if (!body || typeof body !== 'object') return jsonError(400, '請求本文必須是 JSON');
  if (!isUlid(id)) return jsonError(404, '審核項目不存在');

  const operator = await requireOperator();
  if (!operator.ok) return operator.response;

  const result = await resolveClaimFlow(operator.run, id, body, defaultFlowDeps());
  switch (result.status) {
    case 'resolved':
      return jsonOk({ data: { decision: result.decision } });
    case 'invalid':
      return jsonError(400, result.message, { extra: { field: result.field } });
    case 'not_found':
      return jsonError(404, '審核項目不存在');
    case 'wrong_type':
      return jsonError(400, '這不是認領項目');
    case 'already_resolved':
      return jsonError(409, '這個項目已結案');
    case 'has_verified_license':
      return jsonError(409, '執業主體還有已驗證的業別，請先以核對紀錄轉成失效再改歸屬');
    case 'conflict':
      return jsonError(409, '項目的狀態剛被改動，請重新整理');
  }
}
