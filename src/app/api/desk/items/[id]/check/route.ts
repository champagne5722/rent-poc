import { jsonError, jsonOk, readJson } from '@/lib/http';
import { isUlid } from '@/lib/pg/ulid';
import { recordCheckFlow } from '@/lib/practice-entities';
import { defaultFlowDeps } from '@/lib/practice-entities/deps';
import { requireOperator } from '@/lib/practice-entities/operator-tx';

type Ctx = { params: Promise<{ id: string }> };

// 登錄業別核對（MIL-109，ADR-0017 決議 10）。只有平台營運者。
// 相符且營業項目符合業別規則：業別轉已驗證，證據檔刪除。不符：維持待驗證，通知補件。

export async function POST(request: Request, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  const body = (await readJson(request)) as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') return jsonError(400, '請求本文必須是 JSON');
  if (!isUlid(id)) return jsonError(404, '審核項目不存在');

  const operator = await requireOperator();
  if (!operator.ok) return operator.response;

  const result = await recordCheckFlow(operator.run, id, body, defaultFlowDeps());
  switch (result.status) {
    case 'recorded':
      return jsonOk({
        data: {
          checkId: result.checkId,
          from: result.from,
          to: result.to,
          result: result.result,
          lapsedLicenseIds: result.lapsedLicenseIds,
        },
      });
    case 'invalid':
      return jsonError(400, result.message, { extra: { field: result.field } });
    case 'ineligible':
      // 缺少的營業項目（P0-03 AC2）。什麼都沒寫入
      return jsonOk(
        { error: '營業項目不符業別規則，不能判定相符', reasons: result.reasons.map((r) => ({ code: r.code, kind: r.kind, message: r.message, ...(r.code === 'missing_business_item' ? { missing: r.missing } : {}) })) },
        { status: 422 },
      );
    case 'registration_not_approved':
      return jsonError(422, `登記狀態是「${result.registrationStatus}」，不是核准設立，不能判定相符。請改選「不符」或「已廢止」，已驗證的其他業別會一併轉為已失效。`);
    case 'not_found':
      return jsonError(404, '審核項目不存在');
    case 'wrong_type':
      return jsonError(400, '這不是業別核對項目');
    case 'already_resolved':
      return jsonError(409, '這個項目已結案');
    case 'conflict':
      return jsonError(409, '業別的狀態剛被改動，請重新整理後再登錄');
  }
}
