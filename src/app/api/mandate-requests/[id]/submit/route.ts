import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { getFileStore } from '@/lib/file-store';
import { jsonError, jsonOk } from '@/lib/http';
import { deleteTranscriptFiles } from '@/lib/mandate-requests/files';
import {
  NOT_OWNER_ORG_MESSAGE,
  NO_UNITS_MESSAGE,
  REQUEST_EXPIRED_MESSAGE,
  REQUEST_NOT_FOUND_MESSAGE,
  REQUEST_NOT_PENDING_OWNER_MESSAGE,
  UNITS_UNAVAILABLE_MESSAGE,
  UNIT_NOT_FOUND_MESSAGE,
} from '@/lib/mandate-requests/messages';
import { getOwnerRequest, submitMandateRequest } from '@/lib/mandate-requests/owner-repository';
import { inOrgTxAs, readJson } from '@/lib/org-route';
import { isUlid } from '@/lib/pg/ulid';

type Ctx = { params: Promise<{ id: string }> };

const MAX_UNITS = 100;

/**
 * 屋主送出申請。body：{ unit_ids: string[] }，租賃單位的 ID（物件列表的 rental_unit_id），一次申請能含多個，最多 100 個。
 * 租賃單位必須是屋主組織自己登錄、沒封存的。業者代填的資料先用 confirm-draft 確認，確認後登錄的租賃單位也要列在 unit_ids。
 * 200 回 OwnerMandateRequest，狀態是 pending_practice。同交易對業者組織寫一則站內通知，只寫申請種類與租賃單位數量。
 * 錯誤：404 申請不是這個組織的（含不存在），或有租賃單位不是這個組織的（code unit_not_found）。
 * 400 沒選租賃單位。409 申請已失效（expired）、已送出或已結束（not_pending）、
 * 租賃單位已有進行中的申請、有效的委託或有效的包租（units_unavailable，訊息固定，不提是哪一家業者）。
 */
export async function POST(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUlid(id)) return jsonError(404, REQUEST_NOT_FOUND_MESSAGE);
  const body = (await readJson(request)) as Record<string, unknown> | undefined;
  const raw = body?.unit_ids;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_UNITS) return jsonError(400, NO_UNITS_MESSAGE, { extra: { field: 'unit_ids' } });
  if (!raw.every((u) => typeof u === 'string' && isUlid(u))) return jsonError(404, UNIT_NOT_FOUND_MESSAGE, 'unit_not_found');

  const now = new Date();
  let releasedKey: string | null = null;
  const response = await inOrgTxAs(async (tx, rc) => {
    await authorize(tx, 'request.submit', { type: 'org' });
    if (rc.orgKind !== 'owner') return jsonError(403, NOT_OWNER_ORG_MESSAGE);
    const result = await submitMandateRequest(tx, id, raw as string[], now);
    switch (result.outcome) {
      case 'submitted': {
        releasedKey = result.releasedObjectKey;
        return jsonOk({ data: await getOwnerRequest(tx, id, now) });
      }
      case 'not_found':
        return jsonError(404, REQUEST_NOT_FOUND_MESSAGE);
      case 'expired':
        return jsonError(409, REQUEST_EXPIRED_MESSAGE, 'expired');
      case 'not_pending':
        return jsonError(409, REQUEST_NOT_PENDING_OWNER_MESSAGE, 'not_pending');
      case 'no_units':
        return jsonError(400, NO_UNITS_MESSAGE, { extra: { field: 'unit_ids' } });
      case 'unit_not_found':
        return jsonError(404, UNIT_NOT_FOUND_MESSAGE, 'unit_not_found');
      case 'units_occupied':
        return jsonError(409, UNITS_UNAVAILABLE_MESSAGE, 'units_unavailable');
    }
  });
  if (releasedKey) await deleteTranscriptFiles(getFileStore('general'), [releasedKey]);
  return response;
}
