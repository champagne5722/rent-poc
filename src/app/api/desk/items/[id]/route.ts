import { jsonError, jsonOk } from '@/lib/http';
import { isUlid } from '@/lib/pg/ulid';
import { deskTicket, getReviewDetail, inOperatorTx } from '@/lib/practice-entities';

type Ctx = { params: Promise<{ id: string }> };

// 審核項目詳情（MIL-109）：核對表單與歸屬判定需要的資料，含歷次核對紀錄與證據檔中繼資料。只有平台營運者。

export async function GET(_request: Request, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  if (!isUlid(id)) return jsonError(404, '審核項目不存在');
  return inOperatorTx(deskTicket('item', id), async (tx) => {
    const detail = await getReviewDetail(tx, id);
    return detail ? jsonOk({ data: detail }) : jsonError(404, '審核項目不存在');
  });
}
