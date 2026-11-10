import { jsonError, jsonOk } from '@/lib/http';
import { readJson } from '@/lib/org-route';
import { decideOwnershipFlow } from '@/lib/ownership';
import { HELD_MESSAGE } from '@/lib/ownership/messages';
import { requireOwnershipOperator } from '@/lib/ownership/operator';
import { isUlid } from '@/lib/pg/ulid';

type Ctx = { params: Promise<{ id: string }> };

/**
 * 判定出租權源（MIL-201，ADR-0028 決議 3）。只有平台營運者。
 * body：{ key_match, holder_match, holder_masked, reason }。兩項比對各自判定，必須是布林值。
 * holder_masked 是謄本上已遮罩的登記名義人，含證號的值會被拒絕。判定人與時間由伺服器記錄，body 不能指定。
 * 兩項都相符轉已驗證，任一項不符轉驗證失敗。通過或不通過時，登錄的一方收到站內通知。
 * 回 200 與 { outcome }：verified、failed，或 held（項目停在待處理，節點不變，不通知）。
 */
export async function POST(request: Request, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  if (!isUlid(id)) return jsonError(404, '審核項目不存在');
  const operator = await requireOwnershipOperator();
  if (!operator.ok) return operator.response;
  const body = (await readJson(request)) as Record<string, unknown> | null;
  const result = await decideOwnershipFlow(operator.runs, id, {
    keyMatch: body?.key_match,
    holderMatch: body?.holder_match,
    holderMasked: body?.holder_masked,
    reason: body?.reason,
  });
  switch (result.status) {
    case 'recorded':
      return jsonOk({ data: { outcome: result.outcome } });
    case 'held':
      return jsonOk({ data: { outcome: 'held', message: HELD_MESSAGE } });
    case 'invalid':
      return jsonError(400, result.message, { extra: { field: result.field } });
    case 'not_found':
      return jsonError(404, '審核項目不存在');
    case 'already_resolved':
      return jsonError(409, '這個項目已經判定過');
  }
}
