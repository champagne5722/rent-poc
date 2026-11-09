import { NextRequest } from 'next/server';
import { authorize, checkAccess } from '@/lib/authorize';
import {
  getCase,
  getOrgName,
  listCaseEvents,
  listCaseMembers,
  listContractsOfCase,
} from '@/lib/case-store';
import { caseIdOf, caseNotFound, type CaseRouteCtx } from '@/lib/case-store/route';
import { jsonOk } from '@/lib/http';
import { inOrgTxAs } from '@/lib/org-route';

// 案件詳情（MIL-115）：案件、成員、合約與案件事件。
// 主辦組織成員與案件成員都讀得到；成員、合約與事件各依關係過濾（RLS，見 CASE_SCOPED_READS），讀不到的分頁是空的。
// 不是成員、別的組織的案件、不存在的案件，三者的回應逐位元相同（P0-02 AC1）。
export async function GET(_request: NextRequest, { params }: CaseRouteCtx) {
  const id = await caseIdOf(params);
  if (!id) return caseNotFound();
  return inOrgTxAs(async (tx, rc) => {
    await authorize(tx, 'case.read_summary', { type: 'case', id });
    const record = await getCase(tx, id);
    if (!record) return caseNotFound();
    const [orgName, members, contracts, events, manage] = await Promise.all([
      getOrgName(tx, record.orgId),
      listCaseMembers(tx, id),
      listContractsOfCase(tx, id),
      listCaseEvents(tx, id),
      checkAccess(tx, 'case_member.manage', { type: 'case', id }),
    ]);
    return jsonOk({
      data: {
        case: record,
        orgName,
        isHost: record.orgId === rc.orgId,
        members,
        contracts,
        events,
        // 畫面用它決定要不要顯示「加入共同承租人」。真正的檢查在寫入的 route
        canManageMembers: manage.allowed,
      },
    });
  });
}
