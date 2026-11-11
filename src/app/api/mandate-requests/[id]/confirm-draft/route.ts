import { NextRequest } from 'next/server';
import { getFileStore } from '@/lib/file-store';
import { jsonError, jsonOk } from '@/lib/http';
import { confirmDraftFlow } from '@/lib/mandate-requests/flows';
import {
  NOT_OWNER_ORG_MESSAGE,
  NO_DRAFT_MESSAGE,
  REQUEST_EXPIRED_MESSAGE,
  REQUEST_NOT_FOUND_MESSAGE,
  REQUEST_NOT_PENDING_OWNER_MESSAGE,
} from '@/lib/mandate-requests/messages';
import { authorizeOnly, readJson } from '@/lib/org-route';
import { requestContext } from '@/lib/current-request-context';
import { isUlid } from '@/lib/pg/ulid';
import { Unauthenticated } from '@/lib/request-context';

type Ctx = { params: Promise<{ id: string }> };

/**
 * 屋主確認業者代填的資料（MIL-206 驗收 9、10）。body：{ consent: 'agree' | 'decline' }，是否同意謄本與身分證件的個資告知
 * （告知文字在讀申請的回應 consent_notice）。
 * 做什麼：重新驗證代填資料，走既有的登錄入口（registerProperty）登錄在屋主的組織，回應與一般登錄相同：
 * 新物件 201 與 { id, verification_status: 'pending_verification' }，屋主自己已登錄同一個建號 200 與 { id, existing: true }。
 * 建號有沒有撞到別的組織，回應看不出來。業者代傳了謄本而且 consent 是 agree 時，同時把謄本轉成屋主組織的謄本送核對
 * （回應的 transcript：forwarded）。decline 時謄本不轉（declined），申請仍能送出，核對時屋主要自己補件。
 * 回應多帶 rental_unit_id：確認後要把它列進送出的 unit_ids。重複確認回 200 與 already_confirmed。
 * 這個 route 不改業者讀得到的任何資料。
 * 錯誤：404 申請不是這個組織的（含不存在）。409 已失效（expired）、已送出或已結束（not_pending）、沒有代填資料（no_draft）。
 * 400 代填資料的格式不合。
 */
export async function POST(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUlid(id)) return jsonError(404, REQUEST_NOT_FOUND_MESSAGE);
  const body = (await readJson(request)) as Record<string, unknown> | undefined;
  const consent = body?.consent;
  if (consent !== 'agree' && consent !== 'decline') {
    return jsonError(400, '請選擇是否同意個資告知（consent 必須是 agree 或 decline）', { extra: { field: 'consent' } });
  }

  let rc;
  try {
    rc = await requestContext();
  } catch (error) {
    if (error instanceof Unauthenticated) return jsonError(401, error.message);
    throw error;
  }
  if (rc.kind !== 'org') return jsonError(403, '此操作需要組織身分');
  if (rc.orgKind !== 'owner') return jsonError(403, NOT_OWNER_ORG_MESSAGE);
  // 先過權限（確認代填資料，以及登錄物件），再開始登錄
  const denied = (await authorizeOnly('request.confirm_draft', { type: 'org' })) ?? (await authorizeOnly('property.manage', { type: 'org' }));
  if (denied) return denied;

  const result = await confirmDraftFlow({ orgId: rc.orgId, partyId: rc.partyId }, id, consent, { store: getFileStore('general'), now: new Date() });
  switch (result.status) {
    case 'confirmed':
      return result.existing
        ? jsonOk({ data: { id: result.propertyId, existing: true, rental_unit_id: result.rentalUnitId, transcript: result.transcript } })
        : jsonOk(
            {
              data: {
                id: result.propertyId,
                verification_status: 'pending_verification',
                rental_unit_id: result.rentalUnitId,
                transcript: result.transcript,
              },
            },
            { status: 201 },
          );
    case 'already_confirmed':
      return jsonOk({ data: { already_confirmed: true, rental_unit_id: result.rentalUnitId } });
    case 'not_found':
      return jsonError(404, REQUEST_NOT_FOUND_MESSAGE);
    case 'expired':
      return jsonError(409, REQUEST_EXPIRED_MESSAGE, 'expired');
    case 'not_pending':
      return jsonError(409, REQUEST_NOT_PENDING_OWNER_MESSAGE, 'not_pending');
    case 'no_draft':
      return jsonError(409, NO_DRAFT_MESSAGE, 'no_draft');
    case 'draft_invalid':
      return jsonError(400, result.message, { extra: { field: 'draft' } });
  }
}
