import { buildObjectKey, parseObjectKey, sha256Hex, type FileStore } from '../file-store';
import { withTx } from '../pg/database';
import { newUlid } from '../pg/ulid';
import { cleanFileName, detectEvidenceType, EVIDENCE_EXTENSIONS, EVIDENCE_MAX_BYTES, type EvidenceContentType } from '../practice-entities/rules';
import { validateTranscriptForm, type TranscriptFormField, type TranscriptFormInput, type TrustField } from './forms';
import {
  currentSubmissionIdOf,
  OwnershipSubmitRejectedError,
  openTranscript,
  precheckSubmission,
  submitTranscript,
  type StoredTranscript,
} from './repository';

// 把「資料庫交易」和「交易外的事」（寫檔、讀檔）接起來的流程（MIL-201）。route 只負責認證、授權與解析請求。
// 順序的原則：交易內不做外部 I/O（ADR-0012 決議 10）。
// - 送件：先在交易內檢查（同意個資告知、物件狀態），再寫 FileStore，再開交易登記。登記沒成功就刪檔。
// - 讀檔：交易內由資料庫函式寫稽核事件並回 key，提交後才讀 FileStore。先有紀錄才讀得到檔案。

export interface OwnershipFlowDeps {
  store: FileStore;
  now?: () => Date;
}

export interface OwnershipActor {
  orgId: string;
  partyId: string;
}

export interface TranscriptUpload {
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
}

export type SubmitFlowResult =
  | { status: 'submitted'; nodeId: string; submissionId: string }
  | { status: 'invalid'; field: TranscriptFormField | 'file'; message: string; missing?: TrustField[] }
  | { status: 'not_found' }
  | { status: 'archived' }
  | { status: 'no_key' }
  | { status: 'consent_required' }
  | { status: 'already_pending' }
  | { status: 'already_verified' }
  /** 資料庫拒絕（物件已合併或停用等）。 */
  | { status: 'rejected' };

/** 謄本檔案只收 PDF、PNG、JPEG（以內容判斷），一個檔案，10 MB 內。 */
export function checkTranscriptFile(
  upload: TranscriptUpload | null,
): { ok: true; value: TranscriptUpload & { contentType: EvidenceContentType } } | { ok: false; message: string } {
  if (!upload || upload.bytes.length === 0) return { ok: false, message: '請上傳謄本檔案' };
  if (upload.bytes.length > EVIDENCE_MAX_BYTES) return { ok: false, message: `檔案不得超過 ${EVIDENCE_MAX_BYTES / 1024 / 1024} MB` };
  const detected = detectEvidenceType(upload.bytes);
  if (!detected) return { ok: false, message: '謄本必須是 PDF、PNG 或 JPEG' };
  return { ok: true, value: { fileName: cleanFileName(upload.fileName), contentType: detected, bytes: upload.bytes } };
}

export async function submitTranscriptFlow(
  actor: OwnershipActor,
  propertyId: string,
  raw: TranscriptFormInput,
  upload: TranscriptUpload | null,
  deps: OwnershipFlowDeps,
): Promise<SubmitFlowResult> {
  const now = (deps.now ?? (() => new Date()))();
  const form = validateTranscriptForm(raw, now);
  if (!form.ok) return { status: 'invalid', field: form.field, message: form.message, missing: form.missing };
  const file = checkTranscriptFile(upload);
  if (!file.ok) return { status: 'invalid', field: 'file', message: file.message };

  const ctx = { kind: 'org', orgId: actor.orgId, partyId: actor.partyId } as const;
  const pre = await withTx(ctx, (tx) => precheckSubmission(tx, propertyId, actor.partyId));
  if (!pre.ok) return { status: pre.reason };

  const id = newUlid();
  const key = buildObjectKey(actor.orgId, 'transcripts', `${id}.${EVIDENCE_EXTENSIONS[file.value.contentType]}`);
  await deps.store.write(key, file.value.bytes, { contentType: file.value.contentType });
  const stored: StoredTranscript = {
    id,
    objectKey: key,
    sha256: sha256Hex(file.value.bytes),
    byteSize: file.value.bytes.length,
    contentType: file.value.contentType,
    fileName: file.value.fileName,
  };

  try {
    const result = await withTx(ctx, (tx) => submitTranscript(tx, pre.anchorId, form.value, stored));
    if (result.kind === 'submitted') return { status: 'submitted', nodeId: result.nodeId, submissionId: result.submissionId };
    await discard(deps.store, key, id);
    return { status: result.kind };
  } catch (error) {
    await discard(deps.store, key, id);
    if (error instanceof OwnershipSubmitRejectedError) return { status: 'rejected' };
    throw error;
  }
}

/** 最佳努力刪除。登記沒成功時用，刪不掉只留 log，孤兒檔沒有中繼資料指到它。 */
async function discard(store: FileStore, key: ReturnType<typeof buildObjectKey>, id: string): Promise<void> {
  try {
    await store.delete(key);
  } catch (error) {
    console.error('[ownership] 孤兒謄本檔刪除失敗', id, error);
  }
}

export type OpenFileResult =
  | { status: 'ok'; bytes: Uint8Array; contentType: string; fileName: string }
  | { status: 'not_found' }
  | { status: 'file_missing' }
  | { status: 'file_corrupted' };

/** 讀 FileStore 並核對 SHA-256。 */
export async function readTranscriptBytes(
  store: FileStore,
  opened: { key: string; sha256: string; contentType: string; fileName: string },
): Promise<OpenFileResult> {
  const bytes = await store.read(parseObjectKey(opened.key));
  if (!bytes) return { status: 'file_missing' };
  if (sha256Hex(bytes) !== opened.sha256) return { status: 'file_corrupted' };
  return { status: 'ok', bytes, contentType: opened.contentType, fileName: opened.fileName };
}

/** 組織成員開啟物件目前的謄本原檔。資料庫函式同交易寫稽核事件。 */
export async function openOwnTranscriptFlow(actor: OwnershipActor, propertyId: string, deps: OwnershipFlowDeps): Promise<OpenFileResult> {
  const opened = await withTx({ kind: 'org', orgId: actor.orgId, partyId: actor.partyId }, async (tx) => {
    const submissionId = await currentSubmissionIdOf(tx, propertyId);
    return submissionId ? openTranscript(tx, submissionId) : null;
  });
  if (!opened) return { status: 'not_found' };
  return readTranscriptBytes(deps.store, opened);
}
