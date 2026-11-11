import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { jsonError, jsonOk } from '@/lib/http';
import { endMandateRequest } from '@/lib/mandate-requests/decision-repository';
import { NOT_ENDABLE_MESSAGE, NOT_OWNER_ORG_MESSAGE, REQUEST_NOT_FOUND_MESSAGE } from '@/lib/mandate-requests/messages';
import { getOwnerRequest } from '@/lib/mandate-requests/owner-repository';
import { getPracticeRequest } from '@/lib/mandate-requests/repository';
import { inOrgTxAs } from '@/lib/org-route';
import { isUlid } from '@/lib/pg/ulid';

type Ctx = { params: Promise<{ id: string }> };

/**
 * 結束已接受的申請（合約全員完成之前）。業者與屋主都能呼叫，沒有 body：不收原因，資料庫也不存原因。
 * 業者那一方只有 admin（動作 request.end_as_practice），屋主那一方是 admin 與 staff（動作 request.end）。
 * 資料庫函式依呼叫者的組織判斷是哪一方，寫 closed_by，並通知另一方：
 * 業者結束時屋主看到「業者已結束申請」，屋主結束時業者看到「屋主已結束申請」。
 * 200 回呼叫者那一方的形狀：業者是 PracticeMandateRequest，屋主是 OwnerMandateRequest，狀態是 ended，closed_by 是結束的一方。
 * 錯誤：404 申請不是這個組織的（含不存在、第三個屋主的申請）。
 * 409 申請不是已接受，或已失效（code not_pending，兩者回應相同）。
 */
export async function POST(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUlid(id)) return jsonError(404, REQUEST_NOT_FOUND_MESSAGE);
  const now = new Date();
  return inOrgTxAs(async (tx, rc) => {
    if (rc.orgKind !== 'practice' && rc.orgKind !== 'owner') return jsonError(403, NOT_OWNER_ORG_MESSAGE);
    await authorize(tx, rc.orgKind === 'practice' ? 'request.end_as_practice' : 'request.end', { type: 'org' });
    const result = await endMandateRequest(tx, id, now);
    switch (result.outcome) {
      case 'ended':
        return jsonOk({ data: rc.orgKind === 'practice' ? await getPracticeRequest(tx, id, now) : await getOwnerRequest(tx, id, now) });
      case 'not_found':
        return jsonError(404, REQUEST_NOT_FOUND_MESSAGE);
      case 'not_pending':
        return jsonError(409, NOT_ENDABLE_MESSAGE, 'not_pending');
    }
  });
}
