import type Database from 'better-sqlite3';
import type { ContractFileKind, ContractFileStatus } from '../types';

// 簽署任務的文件紀錄（ADR-0010 決議 10）：已簽 PDF 與 Audit Trail File 以簽署任務為鍵。
// 保存結果一律入庫：成功記檔案資訊，失敗記錯誤訊息供補抓。檔案本體在 data/ 下，這裡只記相對路徑。
// 與 sign-task-store.ts 相同，不 import db.ts，連線由呼叫端傳入。

const NOW = "datetime('now', 'localtime')";

export function ensureSignTaskFileTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sign_task_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sign_task_id INTEGER NOT NULL REFERENCES sign_tasks(id),
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      file_name TEXT NOT NULL,
      rel_path TEXT,
      byte_size INTEGER,
      content_type TEXT,
      error TEXT,
      saved_at TEXT NOT NULL DEFAULT (${NOW}),
      UNIQUE (sign_task_id, kind)
    );
  `);
}

// 對外的欄位名沿用 contract_files，GET /api/contracts/[id]/files 的回應形狀才不變
export interface SignTaskFile {
  id: number;
  kind: ContractFileKind;
  status: ContractFileStatus;
  file_name: string;
  rel_path: string | null; // 相對 data/ 的路徑，失敗時為 null
  byte_size: number | null;
  content_type: string | null;
  error: string | null;
  saved_at: string;
}

export type SignTaskFileInput = Omit<SignTaskFile, 'id' | 'saved_at'>;

const COLUMNS = 'id, kind, status, file_name, rel_path, byte_size, content_type, error, saved_at';

// 每個簽署任務的每種文件只留一筆：補抓成功會覆蓋先前的失敗紀錄
export function upsertSignTaskFile(db: Database.Database, signTaskId: number, file: SignTaskFileInput): void {
  db.prepare(
    `INSERT INTO sign_task_files (sign_task_id, kind, status, file_name, rel_path, byte_size, content_type, error, saved_at)
     VALUES (@sign_task_id, @kind, @status, @file_name, @rel_path, @byte_size, @content_type, @error, ${NOW})
     ON CONFLICT (sign_task_id, kind) DO UPDATE SET
       status = excluded.status,
       file_name = excluded.file_name,
       rel_path = excluded.rel_path,
       byte_size = excluded.byte_size,
       content_type = excluded.content_type,
       error = excluded.error,
       saved_at = excluded.saved_at`
  ).run({ ...file, sign_task_id: signTaskId });
}

export function getSignTaskFile(db: Database.Database, signTaskId: number, kind: ContractFileKind): SignTaskFile | null {
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM sign_task_files WHERE sign_task_id = ? AND kind = ?`)
    .get(signTaskId, kind) as SignTaskFile | undefined;
  return row ?? null;
}

export function listSignTaskFiles(db: Database.Database, signTaskId: number): SignTaskFile[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM sign_task_files WHERE sign_task_id = ? ORDER BY kind`)
    .all(signTaskId) as SignTaskFile[];
}
