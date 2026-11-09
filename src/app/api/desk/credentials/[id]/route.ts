import { jsonError, jsonOk } from '@/lib/http';
import { isUlid } from '@/lib/pg/ulid';
import { deskTicket, inOperatorTx } from '@/lib/practice-entities';
import { getCredentialReview } from '@/lib/practitioners';

type Ctx = { params: Promise<{ id: string }> };

// 證書、任職、同意書項目的詳情（MIL-111）：核對表單需要的資料，含同一證號的其他任職、歷次核對與證據檔中繼資料。只有平台營運者。

export async function GET(_request: Request, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  if (!isUlid(id)) return jsonError(404, '審核項目不存在');
  return inOperatorTx(deskTicket('item', id), async (tx) => {
    const detail = await getCredentialReview(tx, id);
    return detail ? jsonOk({ data: detail }) : jsonError(404, '審核項目不存在');
  });
}
