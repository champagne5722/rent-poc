import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { jsonError, jsonOk } from '@/lib/http';
import { declineMandateRequest } from '@/lib/mandate-requests/decision-repository';
import { NOT_PENDING_PRACTICE_MESSAGE, NOT_PRACTICE_ORG_MESSAGE, REQUEST_NOT_FOUND_MESSAGE } from '@/lib/mandate-requests/messages';
import { getPracticeRequest } from '@/lib/mandate-requests/repository';
import { inOrgTxAs } from '@/lib/org-route';
import { isUlid } from '@/lib/pg/ulid';

type Ctx = { params: Promise<{ id: string }> };

/**
 * 業者不接受申請。只有業者組織的 admin 能呼叫。沒有 body：不收原因，資料庫也不存原因，帶了 body 也不讀。
 * 200 回 PracticeMandateRequest，狀態是 declined，closed_by 是 practice。同交易對屋主寫一則站內通知，文字只寫「未接受」。
 * 屋主讀自己的申請時，狀態是 declined，回應沒有原因，也沒有管理人員。
 * 錯誤：404 申請不是這個組織的（含不存在）。
 * 409 申請不是待業者接受，或已失效（code not_pending，兩者回應相同）。
 */
export async function POST(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUlid(id)) return jsonError(404, REQUEST_NOT_FOUND_MESSAGE);
  const now = new Date();
  return inOrgTxAs(async (tx, rc) => {
    await authorize(tx, 'request.decline', { type: 'org' });
    if (rc.orgKind !== 'practice') return jsonError(403, NOT_PRACTICE_ORG_MESSAGE);
    switch (await declineMandateRequest(tx, id, now)) {
      case 'declined':
        return jsonOk({ data: await getPracticeRequest(tx, id, now) });
      case 'not_found':
        return jsonError(404, REQUEST_NOT_FOUND_MESSAGE);
      case 'not_pending':
        return jsonError(409, NOT_PENDING_PRACTICE_MESSAGE, 'not_pending');
    }
  });
}
