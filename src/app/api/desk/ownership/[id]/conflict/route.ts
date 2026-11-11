import { jsonError, jsonOk } from '@/lib/http';
import { getConflictFlow } from '@/lib/ownership/conflict';
import { requireOwnershipOperator } from '@/lib/ownership/operator';
import { isUlid } from '@/lib/pg/ulid';

type Ctx = { params: Promise<{ id: string }> };

/**
 * 兩方都通過核對時，雙方並列的內容（MIL-208）。只有平台營運者。[id] 是審核項目編號（後來的一方的出租權源項目）。
 * 回 { data: OwnershipConflictView }：個案狀態與決定、鍵、先前的一方與後來的一方各自的組織、節點與送件 ID、遮罩的登記名義人、
 * 先前一方通過核對的時間與謄本取得時間，以及全部聯絡紀錄。不含主張的所有權人、信託資料與檔案 key。
 * 後來的一方的取得時間不在這裡：用 GET /api/desk/ownership/[id] 的 submission，避免多讀一次它的組織。
 * 先前的一方的原檔用 GET /api/desk/ownership/[id]/conflict/file。項目沒有衝突個案回 404。
 */
export async function GET(_request: Request, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  if (!isUlid(id)) return jsonError(404, '衝突個案不存在');
  const operator = await requireOwnershipOperator();
  if (!operator.ok) return operator.response;
  const result = await getConflictFlow(operator.runs, id);
  if (result.status === 'not_found') return jsonError(404, '衝突個案不存在');
  return jsonOk({ data: result.conflict });
}
