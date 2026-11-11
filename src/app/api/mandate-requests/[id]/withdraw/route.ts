import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { jsonError, jsonOk } from '@/lib/http';
import {
  NOT_OWNER_ORG_MESSAGE,
  NOT_SUBMITTED_MESSAGE,
  NOT_WITHDRAWABLE_MESSAGE,
  REQUEST_EXPIRED_MESSAGE,
  REQUEST_NOT_FOUND_MESSAGE,
} from '@/lib/mandate-requests/messages';
import { getOwnerRequest, withdrawMandateRequest } from '@/lib/mandate-requests/owner-repository';
import { inOrgTxAs } from '@/lib/org-route';
import { isUlid } from '@/lib/pg/ulid';

type Ctx = { params: Promise<{ id: string }> };

/**
 * 屋主收回申請（業者接受之前）。沒有 body。
 * 200 回 OwnerMandateRequest，狀態是 withdrawn。同交易對業者組織寫一則「申請已收回」的站內通知，不寫原因。
 * 錯誤：404 申請不是這個組織的（含不存在）。
 * 409 申請還沒送出（not_submitted）：屋主沒送出就離開，不需要收回，也不會讓業者知道有人打開過連結。
 * 409 已失效（expired）或已不能收回（not_pending，例如業者已接受）。
 */
export async function POST(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUlid(id)) return jsonError(404, REQUEST_NOT_FOUND_MESSAGE);
  const now = new Date();
  return inOrgTxAs(async (tx, rc) => {
    await authorize(tx, 'request.withdraw', { type: 'org' });
    if (rc.orgKind !== 'owner') return jsonError(403, NOT_OWNER_ORG_MESSAGE);
    switch (await withdrawMandateRequest(tx, id, now)) {
      case 'withdrawn':
        return jsonOk({ data: await getOwnerRequest(tx, id, now) });
      case 'not_found':
        return jsonError(404, REQUEST_NOT_FOUND_MESSAGE);
      case 'not_submitted':
        return jsonError(409, NOT_SUBMITTED_MESSAGE, 'not_submitted');
      case 'expired':
        return jsonError(409, REQUEST_EXPIRED_MESSAGE, 'expired');
      case 'not_pending':
        return jsonError(409, NOT_WITHDRAWABLE_MESSAGE, 'not_pending');
    }
  });
}
