import { appendAudit } from '../audit';
import { buildObjectKey, type FileStore, type ObjectKey, parseObjectKey, sha256Hex } from '../file-store';
import type { OrgTx } from '../pg/with-tx';
import { newUlid } from '../pg/ulid';
import type { LicenseKind } from '../registry-rules';
import { EVIDENCE_EXTENSIONS, type CheckedEvidenceUpload } from './rules';

// 證據檔（MIL-109，ADR-0017 決議 10 與補充）。檔案本體在 FileStore，中繼資料在 vault。
//
// 順序：先寫 FileStore，再開交易登記中繼資料。交易失敗時刪掉剛寫的檔案（discardEvidenceFiles）。
// 反過來不行：交易內不得有外部 I/O（ADR-0012 決議 10）。
// 刪除也是兩段：交易內 vault 標記刪除並寫稽核事件，提交後刪 FileStore 的檔案，再登記已刪（removeDeletedFiles）。
// 提交後刪檔失敗時，vault 的 pending_file_removals() 還找得到它，下一次重試。
//
// FileStore 用 general 用途。key 是 org/<org_id>/vault/credential-evidence/<檔案 ID>.<副檔名>，
// 前綴由 vault.credential_evidence 的 CHECK 保證。獨立的 bucket 是上線前的加強項（見 README）。

export const EVIDENCE_AREA = 'vault';
export const EVIDENCE_FOLDER = 'credential-evidence';

export type EvidenceSubjectType = 'license' | 'claim';

export interface StoredEvidence {
  id: string;
  key: ObjectKey;
  sha256: string;
  byteSize: number;
  contentType: string;
  fileName: string;
}

export interface EvidenceMeta {
  id: string;
  subjectType: EvidenceSubjectType;
  subjectId: string;
  kind: LicenseKind;
  fileName: string;
  contentType: string;
  byteSize: number;
  uploadedAt: string;
  state: 'stored' | 'deleted';
  deletedAt: string | null;
  deleteReason: string | null;
}

export type EvidenceDeleteReason = 'matched' | 'expired' | 'withdrawn' | 'superseded';

/** 寫進 FileStore。中途失敗時把已經寫的刪掉再丟錯，不留孤兒檔。 */
export async function storeEvidenceFiles(store: FileStore, orgId: string, files: CheckedEvidenceUpload[]): Promise<StoredEvidence[]> {
  const stored: StoredEvidence[] = [];
  try {
    for (const file of files) {
      const id = newUlid();
      const key = buildObjectKey(orgId, EVIDENCE_AREA, EVIDENCE_FOLDER, `${id}.${EVIDENCE_EXTENSIONS[file.contentType]}`);
      await store.write(key, file.bytes, { contentType: file.contentType });
      stored.push({ id, key, sha256: sha256Hex(file.bytes), byteSize: file.bytes.length, contentType: file.contentType, fileName: file.fileName });
    }
  } catch (error) {
    await discardEvidenceFiles(store, stored);
    throw error;
  }
  return stored;
}

/** 最佳努力刪除。登記失敗時用，刪不掉只留 log，孤兒檔沒有中繼資料指到它。 */
export async function discardEvidenceFiles(store: FileStore, stored: readonly StoredEvidence[]): Promise<void> {
  for (const file of stored) {
    try {
      await store.delete(file.key);
    } catch (error) {
      console.error('[vault] 孤兒證據檔刪除失敗', file.id, error);
    }
  }
}

/** 登記中繼資料並寫 vault.upload。組織脈絡，對象必須屬於目前組織（資料庫函式檢查）。 */
export async function registerEvidence(
  tx: OrgTx,
  input: { subjectType: EvidenceSubjectType; subjectId: string; kind: LicenseKind; uploadedBy: string; files: readonly StoredEvidence[] },
): Promise<void> {
  for (const file of input.files) {
    await tx.query('SELECT vault.register_credential_evidence($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', [
      file.id, input.subjectType, input.subjectId, input.kind, file.key, file.sha256, file.byteSize, file.contentType, file.fileName, input.uploadedBy,
    ]);
    await appendAudit(tx, {
      action: 'vault.upload',
      object: { type: 'evidence', id: file.id },
      payload: { subject_type: input.subjectType, subject_id: input.subjectId, byte_size: file.byteSize },
    });
  }
}

interface MetaRow {
  id: string;
  subject_type: EvidenceSubjectType;
  subject_id: string;
  kind: LicenseKind;
  file_name: string;
  content_type: string;
  byte_size: string | number;
  uploaded_at: Date | string;
  state: 'stored' | 'deleted';
  deleted_at: Date | string | null;
  delete_reason: string | null;
}

const iso = (value: Date | string): string => new Date(value).toISOString();

/** 證據檔的中繼資料（不含 key）。營運者看全部，組織脈絡只看自己上傳的。 */
export async function listEvidence(
  tx: OrgTx,
  subjectType: EvidenceSubjectType,
  subjectIds: readonly string[],
  includeDeleted = false,
): Promise<EvidenceMeta[]> {
  if (subjectIds.length === 0) return [];
  const { rows } = await tx.query<MetaRow>('SELECT * FROM vault.list_credential_evidence($1, $2::text[], $3)', [subjectType, [...subjectIds], includeDeleted]);
  return rows.map((r) => ({
    id: r.id,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    kind: r.kind,
    fileName: r.file_name,
    contentType: r.content_type,
    byteSize: Number(r.byte_size),
    uploadedAt: iso(r.uploaded_at),
    state: r.state,
    deletedAt: r.deleted_at ? iso(r.deleted_at) : null,
    deleteReason: r.delete_reason,
  }));
}

export interface OpenedEvidence {
  id: string;
  key: ObjectKey;
  sha256: string;
  contentType: string;
  fileName: string;
}

/** 營運者開啟證據檔。同交易寫 vault.read（先有紀錄才能讀）。找不到或已刪除回 null，不寫事件。 */
export async function openEvidence(tx: OrgTx, evidenceId: string): Promise<OpenedEvidence | null> {
  const { rows } = await tx.query<{ id: string; subject_type: string; subject_id: string; object_key: string; sha256: string; content_type: string; file_name: string }>(
    'SELECT * FROM vault.open_credential_evidence($1)',
    [evidenceId],
  );
  const row = rows[0];
  if (!row) return null;
  await appendAudit(tx, {
    action: 'vault.read',
    object: { type: 'evidence', id: row.id },
    payload: { subject_type: row.subject_type, subject_id: row.subject_id },
  });
  return { id: row.id, key: parseObjectKey(row.object_key), sha256: row.sha256, contentType: row.content_type, fileName: row.file_name };
}

export interface DeletedEvidence {
  id: string;
  key: ObjectKey;
}

/**
 * 標記刪除並寫 vault.delete（刪除方式 file_store_delete）。只處理還沒刪除的，重複呼叫不會重複寫事件。
 * 檔案本體要在交易提交後用 removeDeletedFiles 刪。
 */
export async function deleteEvidence(tx: OrgTx, ids: readonly string[], reason: EvidenceDeleteReason): Promise<DeletedEvidence[]> {
  if (ids.length === 0) return [];
  const { rows } = await tx.query<{ id: string; subject_type: string; subject_id: string; object_key: string }>(
    'SELECT * FROM vault.mark_credential_evidence_deleted($1::text[], $2)',
    [[...ids], reason],
  );
  for (const row of rows) {
    await appendAudit(tx, {
      action: 'vault.delete',
      object: { type: 'evidence', id: row.id },
      payload: { reason, method: 'file_store_delete', subject_type: row.subject_type, subject_id: row.subject_id },
    });
  }
  return rows.map((r) => ({ id: r.id, key: parseObjectKey(r.object_key) }));
}

/** 提交後刪 FileStore 的檔案，成功的回傳 ID 讓呼叫端登記。失敗的留在 pending_file_removals。 */
export async function removeDeletedFiles(store: FileStore, deleted: readonly DeletedEvidence[]): Promise<string[]> {
  const removed: string[] = [];
  for (const file of deleted) {
    try {
      await store.delete(file.key);
      removed.push(file.id);
    } catch (error) {
      console.error('[vault] 證據檔刪除失敗，留待重試', file.id, error);
    }
  }
  return removed;
}

export async function confirmFilesRemoved(tx: OrgTx, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx.query('SELECT vault.confirm_credential_evidence_file_removed($1::text[])', [[...ids]]);
}

/** 資料庫已標記刪除、檔案還沒確認刪掉的證據檔，供重試（MIL-112 的 worker 會用）。 */
export async function pendingFileRemovals(tx: OrgTx, limit = 100): Promise<DeletedEvidence[]> {
  const { rows } = await tx.query<{ id: string; object_key: string }>('SELECT * FROM vault.pending_file_removals($1)', [limit]);
  return rows.map((r) => ({ id: r.id, key: parseObjectKey(r.object_key) }));
}

/** 認領歸屬改給認領方時，把認領項目上的證據檔改掛到業別。 */
export async function transferClaimEvidence(tx: OrgTx, claimItemId: string, licenseIdByKind: Record<string, string>): Promise<void> {
  await tx.query('SELECT vault.transfer_claim_evidence($1, $2::jsonb)', [claimItemId, JSON.stringify(licenseIdByKind)]);
}
