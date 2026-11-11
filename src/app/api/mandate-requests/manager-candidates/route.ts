import { authorize } from '@/lib/authorize';
import { jsonError, jsonOk } from '@/lib/http';
import { listManagerCandidates } from '@/lib/mandate-requests/decision-repository';
import { NOT_PRACTICE_ORG_MESSAGE } from '@/lib/mandate-requests/messages';
import { inOrgTxAs } from '@/lib/org-route';

/**
 * 業者接受申請時能指派的管理人員。只有業者組織的 admin 能讀（與接受同一個角色）。
 * 200 回 { data: MandateManagerCandidate[] }：任職 ID、姓名、證書種類。只回自己組織現在有效的租賃住宅管理人員，
 * 不做跨組織查詢，不回證號與 email。空陣列代表沒有合格的人，畫面停用接受鍵並提示先完成人員驗證。
 */
export async function GET() {
  const now = new Date();
  return inOrgTxAs(async (tx, rc) => {
    await authorize(tx, 'request.manager_candidates', { type: 'org' });
    if (rc.orgKind !== 'practice') return jsonError(403, NOT_PRACTICE_ORG_MESSAGE);
    return jsonOk({ data: await listManagerCandidates(tx, now) });
  });
}
