import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { readSessionToken } from '@/lib/auth/cookie';
import { jsonError, jsonOk, readJson } from '@/lib/http';
import { prepareClaim } from '@/lib/mandate-requests/claim';
import { isWellFormedRequestCode } from '@/lib/mandate-requests/code';
import {
  IDENTITY_NOT_CHOSEN_MESSAGE,
  LINK_INVALID_MESSAGE,
  NOT_OWNER_ORG_MESSAGE,
  OWNER_NAME_REQUIRED_MESSAGE,
} from '@/lib/mandate-requests/messages';
import { claimMandateRequest, getOwnerRequest } from '@/lib/mandate-requests/owner-repository';
import { inOrgTxFor } from '@/lib/mandate-requests/route-support';

type Ctx = { params: Promise<{ code: string }> };

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * 屋主登入後綁定連結（MIL-206 驗收 7）。需要 session cookie（用 email 驗證碼登入後取得）。
 * body：{ owner_name?: string }。帳號還沒有任何身分時，owner_name 必填，系統用它建立屋主的組織並切換過去。
 * 200 回 { data: { request: OwnerMandateRequest, created_owner_org: boolean } }。
 * 已經綁定過的屋主組織再呼叫，同樣回 200。
 * 錯誤：401 未登入。404 連結無效（格式錯誤、查無此碼、已過期、已送出、已收回、已被別的組織綁定，回應逐位元相同）。
 * 403 帳號屬於業者或其他組織，或唯讀成員。409 帳號有多個身分，要先切換成屋主身分。400 沒填屋主名稱或名稱格式不合。
 * 這個 route 不寄任何 email，也不改變業者讀得到的任何資料：業者看不出屋主打開或綁定過連結。
 */
export async function POST(request: NextRequest, { params }: Ctx) {
  const { code } = await params;
  const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
  if (!isWellFormedRequestCode(code)) return jsonError(404, LINK_INVALID_MESSAGE, { headers: NO_STORE });
  const now = new Date();

  const prepared = await prepareClaim(readSessionToken(request.headers.get('cookie')), code, body.owner_name, now);
  switch (prepared.status) {
    case 'unauthenticated':
      return jsonError(401, '尚未登入或沒有存取權');
    case 'unavailable':
      return jsonError(404, LINK_INVALID_MESSAGE, { headers: NO_STORE });
    case 'identity_not_chosen':
      return jsonError(409, IDENTITY_NOT_CHOSEN_MESSAGE, 'identity_not_chosen');
    case 'not_owner':
      return jsonError(403, NOT_OWNER_ORG_MESSAGE, 'not_owner');
    case 'name_required':
      return jsonError(400, OWNER_NAME_REQUIRED_MESSAGE, { extra: { field: 'owner_name', code: 'owner_name_required' } });
    case 'invalid_name':
      return jsonError(400, prepared.message, { extra: { field: 'owner_name' } });
    case 'ready':
      break;
  }

  return inOrgTxFor(prepared.rc, async (tx) => {
    await authorize(tx, 'request.claim', { type: 'org' });
    const claimed = await claimMandateRequest(tx, code, now);
    if (claimed.outcome === 'not_owner') return jsonError(403, NOT_OWNER_ORG_MESSAGE, 'not_owner');
    if (claimed.outcome === 'unavailable' || !claimed.requestId) return jsonError(404, LINK_INVALID_MESSAGE, { headers: NO_STORE });
    const view = await getOwnerRequest(tx, claimed.requestId, now);
    return jsonOk({ data: { request: view, created_owner_org: prepared.createdOrg } }, { headers: NO_STORE });
  });
}
