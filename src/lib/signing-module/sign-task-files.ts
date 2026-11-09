import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import type { ContractFileKind, ContractFileStatus } from '../types';

// 簽署任務的文件紀錄（ADR-0010 決議 10，MIL-85 搬進 PostgreSQL）：已簽 PDF 與 Audit Trail File 以簽署任務為鍵。
// 保存結果一律入庫：成功記檔案資訊，失敗記錯誤訊息供補抓。檔案本體在 FileStore（MIL-87），
// 這裡只記物件 key 與 SHA-256，不記本機路徑。表見 db/migrations/0006_sign_tasks.sql 與 0008_file_store.sql。

// 對外的欄位名沿用 contract_files，GET /api/contracts/[id]/files 的回應形狀才不變
export interface SignTaskFile {
  id: string;
  kind: ContractFileKind;
  status: ContractFileStatus;
  file_name: string;
  object_key: string | null; // FileStore 的物件 key（含 org_id），失敗時為 null
  sha256: string | null; // 檔案內容的 SHA-256，失敗時為 null
  byte_size: number | null;
  content_type: string | null;
  error: string | null;
  saved_at: string;
}

export type SignTaskFileInput = Omit<SignTaskFile, 'id' | 'saved_at'>;

const COLUMNS = 'id, kind, status, file_name, object_key, sha256, byte_size, content_type, error, saved_at';

interface FileRow extends Omit<SignTaskFile, 'saved_at'> {
  saved_at: Date;
}

const toFile = (row: FileRow): SignTaskFile => ({ ...row, saved_at: row.saved_at.toISOString() });

// 每個簽署任務的每種文件只留一筆：補抓成功會覆蓋先前的失敗紀錄
export async function upsertSignTaskFile(tx: OrgTx, signTaskId: string, file: SignTaskFileInput): Promise<void> {
  await tx.query(
    `INSERT INTO org.sign_task_files
       (id, org_id, sign_task_id, kind, status, file_name, object_key, sha256, byte_size, content_type, error, saved_at)
     VALUES ($1, current_setting('app.org_id', true), $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (org_id, sign_task_id, kind) DO UPDATE SET
       status = excluded.status,
       file_name = excluded.file_name,
       object_key = excluded.object_key,
       sha256 = excluded.sha256,
       byte_size = excluded.byte_size,
       content_type = excluded.content_type,
       error = excluded.error,
       saved_at = excluded.saved_at`,
    [
      newUlid(),
      signTaskId,
      file.kind,
      file.status,
      file.file_name,
      file.object_key,
      file.sha256,
      file.byte_size,
      file.content_type,
      file.error,
    ],
  );
}

export async function getSignTaskFile(
  tx: OrgTx,
  signTaskId: string,
  kind: ContractFileKind,
): Promise<SignTaskFile | null> {
  const { rows } = await tx.query<FileRow>(
    `SELECT ${COLUMNS} FROM org.sign_task_files WHERE sign_task_id = $1 AND kind = $2`,
    [signTaskId, kind],
  );
  return rows[0] ? toFile(rows[0]) : null;
}

export async function listSignTaskFiles(tx: OrgTx, signTaskId: string): Promise<SignTaskFile[]> {
  const { rows } = await tx.query<FileRow>(
    `SELECT ${COLUMNS} FROM org.sign_task_files WHERE sign_task_id = $1 ORDER BY kind`,
    [signTaskId],
  );
  return rows.map(toFile);
}
