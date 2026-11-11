import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { listCaseSummaries } from '@/lib/case-store';
import { jsonOk } from '@/lib/http';
import { inOrgTxAs } from '@/lib/org-route';
import { isUlid } from '@/lib/pg/ulid';
import { getProperty } from '@/lib/properties';
import { propertyNotFound } from '@/lib/properties/not-found';

// 案件清單（MIL-115）：目前組織主辦的案件，加上自己是成員的別組織案件。
// 每一列的 isHost 讓畫面分出「我主辦」與「我是成員」。成員名稱依 RLS 篩選，讀不到時是 null。
//
// 加 `?property_id=<id>`（MIL-209）：只回這個物件的案件，畫面據 `caseKind`、`state` 與兩個連結欄位顯示物件的案件列表。
// 物件必須是目前組織自己的。格式錯誤、別的組織的、不存在的物件，回應與 GET /api/properties/[id] 的「不存在」逐位元相同，
// 所以呼叫者無法由這個篩選得知別的組織有沒有這個物件或案件。
export async function GET(request: NextRequest) {
  const propertyId = request.nextUrl.searchParams.get('property_id');
  if (propertyId !== null && !isUlid(propertyId)) return propertyNotFound();
  return inOrgTxAs(async (tx, rc) => {
    await authorize(tx, 'case.list', { type: 'org' });
    if (propertyId !== null && !(await getProperty(tx, propertyId))) return propertyNotFound();
    const rows = await listCaseSummaries(tx, propertyId === null ? {} : { propertyId });
    return jsonOk({ data: rows.map((row) => ({ ...row, isHost: row.orgId === rc.orgId })) });
  });
}
