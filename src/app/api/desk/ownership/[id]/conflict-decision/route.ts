import { jsonError, jsonOk } from '@/lib/http';
import { readJson } from '@/lib/org-route';
import { decideConflictFlow } from '@/lib/ownership/conflict';
import { requireOwnershipOperator } from '@/lib/ownership/operator';
import { isUlid } from '@/lib/pg/ulid';

type Ctx = { params: Promise<{ id: string }> };

/**
 * 決定兩方都通過核對的衝突（MIL-208，ADR-0028 決議 4，ADR-0025 決議 11）。只有平台營運者。[id] 是後來的一方的審核項目編號。
 * body：{ decision, reason, basis? }。decision 是三種之一：
 * - later_prevails：後來的成立，先前的一方的節點轉已失效並收到通知（文字不提另一方）。先前一方既有的案件與合約不自動取消。
 * - later_rejected：後來的不成立。basis 必填（key_mismatch、holder_mismatch、both_mismatch），走既有的驗證失敗訊息。
 * - coexist：兩方並存。後來的物件併入先前的物件（merged_into_id），兩方的節點都是已驗證。
 * reason 是 500 字以內的理由。決定人與時間由伺服器記錄，body 不能指定。
 * 回 200 與 { data: { decision, affected_case_count } }。affected_case_count 只有 later_prevails 有值（先前一方進行中的案件數），其餘是 0。
 * 項目沒有個案回 404，已決定回 409，資料庫拒絕（狀態已變、鍵有多個並存的節點）回 409，欄位不合格回 400 與 { field }。
 */
export async function POST(request: Request, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  if (!isUlid(id)) return jsonError(404, '衝突個案不存在');
  const operator = await requireOwnershipOperator();
  if (!operator.ok) return operator.response;
  const body = (await readJson(request)) as Record<string, unknown> | null;
  const result = await decideConflictFlow(operator.runs, id, { decision: body?.decision, reason: body?.reason, basis: body?.basis });
  switch (result.status) {
    case 'decided':
      return jsonOk({ data: { decision: result.decision, affected_case_count: result.affectedCaseCount } });
    case 'invalid':
      return jsonError(400, result.message, { extra: { field: result.field } });
    case 'not_found':
      return jsonError(404, '衝突個案不存在');
    case 'already_decided':
      return jsonError(409, '這個衝突已經決定過');
    case 'rejected':
      return jsonError(409, result.message);
  }
}
