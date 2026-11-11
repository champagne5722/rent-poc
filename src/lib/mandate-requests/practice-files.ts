import { appendAudit } from '../audit';
import { buildObjectKey, sha256Hex, type FileStore } from '../file-store';
import { checkTranscriptFile, readTranscriptBytes, type OpenFileResult, type TranscriptUpload } from '../ownership';
import { validateTranscriptForm, type TranscriptFormField, type TranscriptFormInput, type TrustField } from '../ownership/forms';
import { withTx } from '../pg/database';
import { newUlid } from '../pg/ulid';
import { EVIDENCE_EXTENSIONS } from '../practice-entities/rules';
import { deleteTranscriptFiles } from './files';
import type { OwnerActor as OrgActor } from './flows';

// 業者代傳謄本與讀原檔（MIL-206 驗收 3）。route 只負責認證、授權與解析請求。
// 順序的原則：交易內不做外部 I/O（ADR-0012 決議 10）。
// - 代傳：先驗證表單與檔案，寫 FileStore，再開交易登記在申請上。登記沒成功就刪檔。被取代的舊檔在提交後刪除。
// - 讀檔：交易內寫稽核事件 request.file_read 並取得 key，提交後才讀 FileStore。先有紀錄才讀得到檔案。
// 檔案放業者組織名下：org/<業者組織 ID>/registry-requests/<申請 ID>/transcript-<ULID>.<副檔名>。
// 屋主確認前，原檔只有產生連結的業者能讀。屋主送出、收回或連結失效時，檔案刪除。

export interface PracticeFileDeps {
  store: FileStore;
  now: Date;
}

export type AttachResult =
  | { status: 'attached'; fileName: string }
  | { status: 'invalid'; field: TranscriptFormField | 'file'; message: string; missing?: TrustField[] }
  | { status: 'not_found' | 'expired' | 'not_pending' };

export async function attachTranscriptFlow(
  actor: OrgActor,
  requestId: string,
  raw: TranscriptFormInput,
  upload: TranscriptUpload | null,
  deps: PracticeFileDeps,
): Promise<AttachResult> {
  const form = validateTranscriptForm(raw, deps.now);
  if (!form.ok) return { status: 'invalid', field: form.field, message: form.message, missing: form.missing };
  const file = checkTranscriptFile(upload);
  if (!file.ok) return { status: 'invalid', field: 'file', message: file.message };

  const key = buildObjectKey(actor.orgId, 'registry-requests', requestId, `transcript-${newUlid()}.${EVIDENCE_EXTENSIONS[file.value.contentType]}`);
  await deps.store.write(key, file.value.bytes, { contentType: file.value.contentType });

  const meta = {
    object_key: key,
    sha256: sha256Hex(file.value.bytes),
    byte_size: file.value.bytes.length,
    content_type: file.value.contentType,
    file_name: file.value.fileName,
    // 謄本表單欄位照業者送來的原文存（已通過驗證）。屋主同意之後，伺服器用它呼叫既有的送件路徑
    form: {
      claimed_owner: raw.claimedOwner,
      acquired_at: raw.acquiredAt,
      has_trust: raw.hasTrust === true || raw.hasTrust === 'true' || raw.hasTrust === '1' || raw.hasTrust === 'on',
      trust_registered_owner: raw.trustRegisteredOwner,
      trust_related_parties: raw.trustRelatedParties,
      trust_registration_status: raw.trustRegistrationStatus,
      trust_lease_clause: raw.trustLeaseClause,
    },
  };

  let outcome: { status: string; replacedKey: string | null };
  try {
    outcome = await withTx({ kind: 'org', orgId: actor.orgId, partyId: actor.partyId }, async (tx) => {
      const { rows } = await tx.query<{ outcome: string; replaced_object_key: string | null }>(
        'SELECT * FROM registry.attach_mandate_request_transcript($1, $2::jsonb, $3)',
        [requestId, JSON.stringify(meta), deps.now],
      );
      if (rows[0].outcome === 'attached') {
        await appendAudit(tx, {
          action: 'request.attach_file',
          object: { type: 'mandate_request', id: requestId },
          payload: { byte_size: meta.byte_size },
        });
      }
      return { status: rows[0].outcome, replacedKey: rows[0].replaced_object_key };
    });
  } catch (error) {
    await deleteTranscriptFiles(deps.store, [key]);
    throw error;
  }
  if (outcome.status !== 'attached') {
    await deleteTranscriptFiles(deps.store, [key]);
    return { status: outcome.status as 'not_found' | 'expired' | 'not_pending' };
  }
  if (outcome.replacedKey) await deleteTranscriptFiles(deps.store, [outcome.replacedKey]);
  return { status: 'attached', fileName: meta.file_name };
}

/** 業者開啟自己代傳的謄本原檔。同交易寫稽核事件，事件寫入後才讀檔。 */
export async function openPracticeFileFlow(actor: OrgActor, requestId: string, deps: PracticeFileDeps): Promise<OpenFileResult> {
  const opened = await withTx({ kind: 'org', orgId: actor.orgId, partyId: actor.partyId }, async (tx) => {
    const { rows } = await tx.query<{ object_key: string; sha256: string; content_type: string; file_name: string }>(
      'SELECT * FROM registry.mandate_request_file_for_practice($1, $2)',
      [requestId, deps.now],
    );
    if (!rows[0]) return null;
    await appendAudit(tx, { action: 'request.file_read', object: { type: 'mandate_request', id: requestId }, payload: {} });
    return { key: rows[0].object_key, sha256: rows[0].sha256, contentType: rows[0].content_type, fileName: rows[0].file_name };
  });
  if (!opened) return { status: 'not_found' };
  return readTranscriptBytes(deps.store, opened);
}
