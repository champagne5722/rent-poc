import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { requestContext } from '@/lib/current-request-context';
import { getFileStore } from '@/lib/file-store';
import { jsonError, jsonOk } from '@/lib/http';
import { authorizeOnly, inOrgTxAs } from '@/lib/org-route';
import { AWAITING_REVIEW_MESSAGE } from '@/lib/ownership/messages';
import { EVIDENCE_MAX_BYTES } from '@/lib/practice-entities';
import { getPropertyOwnership, submitTranscriptFlow, type TranscriptUpload } from '@/lib/ownership';
import { isUlid } from '@/lib/pg/ulid';
import { propertyNotFound } from '@/lib/properties/not-found';
import { Unauthenticated } from '@/lib/request-context';

type Ctx = { params: Promise<{ id: string }> };

// 物件的所有權文件（MIL-201，ADR-0026、ADR-0028 決議 3）。
// 格式錯誤、別的組織、不存在的 ID，回應必須逐位元相同（P0-02 AC1），統一用 propertyNotFound()。
// 回應只含呼叫者自己組織的資料。別的組織是否登錄過同一個鍵，這裡看不出來。

/**
 * 讀物件的所有權文件狀態：核對狀態、給使用者看的固定訊息、最新一次送件、是否能送出、個資告知與同意狀態。
 * 形狀見 src/lib/types.ts 的 PropertyOwnership。
 */
export async function GET(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUlid(id)) return propertyNotFound();
  return inOrgTxAs(async (tx, rc) => {
    await authorize(tx, 'property.read', { type: 'property', id });
    const ownership = await getPropertyOwnership(tx, id, rc.partyId);
    if (!ownership) return propertyNotFound();
    return jsonOk({ data: ownership });
  });
}

/**
 * 送出第二類謄本。multipart：file、claimed_owner（主張的所有權人）、acquired_at（謄本取得時間，YYYY-MM-DD 或 ISO）、
 * has_trust（謄本顯示信託登記時為 true）與信託四項 trust_registered_owner、trust_related_parties、
 * trust_registration_status、trust_lease_clause。
 * 必須先同意個資告知（POST .../ownership/consent），否則 403 consent_required。
 * 信託四項缺件時回 400 與 missing（缺的欄位陣列），狀態不變（P0-08 AC3）。
 */
export async function POST(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUlid(id)) return propertyNotFound();
  let rc;
  try {
    rc = await requestContext();
  } catch (error) {
    if (error instanceof Unauthenticated) return jsonError(401, error.message);
    throw error;
  }
  if (rc.kind !== 'org') return jsonError(403, '此操作需要組織身分');
  // 先過權限，再把檔案讀進記憶體
  const denied = await authorizeOnly('property.manage', { type: 'property', id });
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

  const result = await submitTranscriptFlow(
    { orgId: rc.orgId, partyId: rc.partyId },
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
    { store: getFileStore('general') },
  );
  switch (result.status) {
    case 'submitted':
      return jsonOk({ data: { id, verification_status: 'pending_verification', message: AWAITING_REVIEW_MESSAGE } }, { status: 201 });
    case 'invalid':
      if (result.missing) return jsonOk({ error: result.message, field: result.field, code: 'trust_incomplete', missing: result.missing }, { status: 400 });
      return jsonError(400, result.message, { extra: { field: result.field } });
    case 'not_found':
      return propertyNotFound();
    case 'archived':
      return jsonError(409, '物件已封存，不能上傳謄本', 'archived');
    case 'no_key':
      return jsonError(409, '請先填建號，再上傳謄本', 'key_required');
    case 'consent_required':
      return jsonError(403, '請先閱讀並同意謄本與身分證件個資告知', 'consent_required');
    case 'already_pending':
      return jsonError(409, AWAITING_REVIEW_MESSAGE, 'already_pending');
    case 'already_verified':
      return jsonError(409, '物件已通過核對，不需要再送謄本', 'already_verified');
    case 'rejected':
      return jsonError(409, '物件目前不能送出謄本', 'rejected');
  }
}
