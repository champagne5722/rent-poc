import { jsonError, jsonOk } from '@/lib/http';
import { getOwnershipReviewDetail } from '@/lib/ownership';
import { requireOwnershipOperator } from '@/lib/ownership/operator';
import { isUlid } from '@/lib/pg/ulid';

type Ctx = { params: Promise<{ id: string }> };

/**
 * 審核台的出租權源項目詳情（MIL-201）。只有平台營運者。
 * 回登錄方組織名稱、送件當下的鍵與段名（與謄本比對用）、節點狀態、最新送件（主張的所有權人、取得時間、信託四項、檔案資料）、
 * 等待時間（只算週一到週五）、是否超過 1 個工作日，以及是否因別的組織已有已驗證的節點而停住。
 * 讀登錄方的資料時用該組織的 operator 脈絡，工單號是項目編號（ADR-0026 決議 7）。
 */
export async function GET(_request: Request, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  if (!isUlid(id)) return jsonError(404, '審核項目不存在');
  const operator = await requireOwnershipOperator();
  if (!operator.ok) return operator.response;
  const detail = await getOwnershipReviewDetail(operator.runs, id, new Date());
  if (!detail) return jsonError(404, '審核項目不存在');
  return jsonOk({ data: detail });
}
