import { authorize } from '@/lib/authorize';
import { listCaseSummaries } from '@/lib/case-store';
import { jsonOk } from '@/lib/http';
import { inOrgTxAs } from '@/lib/org-route';

// 案件清單（MIL-115）：目前組織主辦的案件，加上自己是成員的別組織案件。
// 每一列的 isHost 讓畫面分出「我主辦」與「我是成員」。成員名稱依 RLS 篩選，讀不到時是 null。
export async function GET() {
  return inOrgTxAs(async (tx, rc) => {
    await authorize(tx, 'case.list', { type: 'org' });
    const rows = await listCaseSummaries(tx);
    return jsonOk({ data: rows.map((row) => ({ ...row, isHost: row.orgId === rc.orgId })) });
  });
}
