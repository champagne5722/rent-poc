import { NextRequest } from 'next/server';
import { requestContext } from '@/lib/current-request-context';
import { getFileStore } from '@/lib/file-store';
import { jsonError, jsonOk } from '@/lib/http';
import {
  PRACTICE_ORG_REQUIRED_MESSAGE,
  REQUEST_EXPIRED_MESSAGE,
  REQUEST_NOT_FOUND_MESSAGE,
  REQUEST_NOT_PENDING_OWNER_MESSAGE,
} from '@/lib/mandate-requests/messages';
import { attachTranscriptFlow, openPracticeFileFlow } from '@/lib/mandate-requests/practice-files';
import { authorizeOnly } from '@/lib/org-route';
import { EVIDENCE_MAX_BYTES } from '@/lib/practice-entities';
import type { TranscriptUpload } from '@/lib/ownership';
import { isUlid } from '@/lib/pg/ulid';
import { Unauthenticated } from '@/lib/request-context';

type Ctx = { params: Promise<{ id: string }> };

async function practiceContext() {
  try {
    const rc = await requestContext();
    if (rc.kind !== 'org') return { response: jsonError(403, '此操作需要組織身分') };
    if (rc.orgKind !== 'practice') return { response: jsonError(403, PRACTICE_ORG_REQUIRED_MESSAGE) };
    return { rc };
  } catch (error) {
    if (error instanceof Unauthenticated) return { response: jsonError(401, error.message) };
    throw error;
  }
}

/**
 * 業者代傳謄本（MIL-206 驗收 3）。multipart：file，加上與物件頁上傳謄本相同的表單欄位：claimed_owner（主張的所有權人）、
 * acquired_at（謄本取得時間）、has_trust 與信託四項 trust_*。申請必須是待屋主確認而且沒失效。再傳一次會取代上一份，舊檔刪除。
 * 201 回 { data: { id, file_name } }。檔案放業者組織名下，屋主確認前只有產生連結的業者能讀。
 * 業者代傳不代表屋主同意個資告知：屋主在 confirm-draft 同意之後，伺服器才把謄本轉成屋主組織的謄本送核對。
 * 錯誤：400 表單或檔案不合格。404 申請不是這個組織的（含不存在）。409 已失效（expired）或已送出（not_pending）。
 */
export async function POST(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUlid(id)) return jsonError(404, REQUEST_NOT_FOUND_MESSAGE);
  const ctx = await practiceContext();
  if (!ctx.rc) return ctx.response;
  const denied = await authorizeOnly('request.attach_file', { type: 'org' });
  if (denied) return denied;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError(400, '請求本文必須是表單資料');
  }
  const uploaded = form.get('file');
  if (uploaded !== null && typeof uploaded !== 'string' && uploaded.size > EVIDENCE_MAX_BYTES) {
    return jsonError(400, `檔案不得超過 ${EVIDENCE_MAX_BYTES / 1024 / 1024} MB`, { extra: { field: 'file' } });
  }
  const upload: TranscriptUpload | null =
    uploaded !== null && typeof uploaded !== 'string'
      ? { fileName: uploaded.name, contentType: uploaded.type, bytes: new Uint8Array(await uploaded.arrayBuffer()) }
      : null;

  const result = await attachTranscriptFlow(
    { orgId: ctx.rc.orgId, partyId: ctx.rc.partyId },
    id,
    {
      claimedOwner: form.get('claimed_owner'),
      acquiredAt: form.get('acquired_at'),
      hasTrust: form.get('has_trust'),
      trustRegisteredOwner: form.get('trust_registered_owner'),
      trustRelatedParties: form.get('trust_related_parties'),
      trustRegistrationStatus: form.get('trust_registration_status'),
      trustLeaseClause: form.get('trust_lease_clause'),
    },
    upload,
    { store: getFileStore('general'), now: new Date() },
  );
  switch (result.status) {
    case 'attached':
      return jsonOk({ data: { id, file_name: result.fileName } }, { status: 201 });
    case 'invalid':
      if (result.missing) return jsonOk({ error: result.message, field: result.field, code: 'trust_incomplete', missing: result.missing }, { status: 400 });
      return jsonError(400, result.message, { extra: { field: result.field } });
    case 'not_found':
      return jsonError(404, REQUEST_NOT_FOUND_MESSAGE);
    case 'expired':
      return jsonError(409, REQUEST_EXPIRED_MESSAGE, 'expired');
    case 'not_pending':
      return jsonError(409, REQUEST_NOT_PENDING_OWNER_MESSAGE, 'not_pending');
  }
}

/**
 * 業者開啟自己代傳的謄本原檔。只有 admin 與 staff。每次開啟在同一個交易寫稽核事件 request.file_read，事件寫入後才讀檔。
 * 屋主送出、收回或連結失效後，檔案已刪，回 404。檔案加 nosniff 與 no-store。
 * 別的組織的申請、沒有代傳謄本、不存在的申請，回應逐位元相同。
 */
export async function GET(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUlid(id)) return jsonError(404, REQUEST_NOT_FOUND_MESSAGE);
  const ctx = await practiceContext();
  if (!ctx.rc) return ctx.response;
  const denied = await authorizeOnly('request.read_file', { type: 'org' });
  if (denied) return denied;

  const result = await openPracticeFileFlow({ orgId: ctx.rc.orgId, partyId: ctx.rc.partyId }, id, { store: getFileStore('general'), now: new Date() });
  switch (result.status) {
    case 'ok':
      return new Response(Buffer.from(result.bytes), {
        headers: {
          'content-type': result.contentType,
          'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        },
      });
    case 'not_found':
    case 'file_missing':
      return jsonError(404, REQUEST_NOT_FOUND_MESSAGE);
    case 'file_corrupted':
      return jsonError(409, '謄本的內容與登記時不同，已拒絕開啟');
  }
}
