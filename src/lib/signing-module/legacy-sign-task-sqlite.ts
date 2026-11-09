import type Database from 'better-sqlite3';
import dayjs from 'dayjs';
import type { ContractFileKind } from '../types';
import type { SigningProviderId, SigningSubject, SigningSubjectType } from './provider';
import {
  currentSignerOf,
  type NewSignTask,
  type SignerRecord,
  type SigningProgress,
  type SignTaskStatus,
} from './sign-task-store';

// 舊 SQLite 的簽署任務、簽署人與文件紀錄存取（MIL-85 把正式的存取搬進 PostgreSQL 後留下）。
// 只給 contract-backfill.ts 與它的測試用，簽署模組本身不再讀寫 SQLite。
// 去留由 MIL-90 決定：搬資料腳本要讀舊檔時可參考這裡的欄位，MIL-91 移除 SQLite 時一併刪除。

const NOW = "datetime('now', 'localtime')";

export function ensureLegacySignTaskTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sign_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      provider_task_ref TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'in_progress',
      created_at TEXT NOT NULL DEFAULT (${NOW}),
      updated_at TEXT,
      UNIQUE (subject_type, subject_id),
      UNIQUE (provider, provider_task_ref)
    );

    CREATE TABLE IF NOT EXISTS signers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sign_task_id INTEGER NOT NULL REFERENCES sign_tasks(id),
      position INTEGER NOT NULL,
      role TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      signed_at TEXT,
      concurrent_roles TEXT,
      UNIQUE (sign_task_id, position)
    );

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

export interface LegacySignTaskRecord {
  id: number;
  taskRef: string;
  status: SignTaskStatus;
  signers: SignerRecord[];
}

export function findLegacySignTask(db: Database.Database, subject: SigningSubject): LegacySignTaskRecord | null {
  const row = db
    .prepare('SELECT id, provider_task_ref, status FROM sign_tasks WHERE subject_type = ? AND subject_id = ?')
    .get(subject.type, subject.id) as { id: number; provider_task_ref: string; status: SignTaskStatus } | undefined;
  if (!row) return null;

  const signerRows = db
    .prepare(
      `SELECT role, name, email, status, signed_at AS "signedAt", concurrent_roles AS "concurrentRoles" FROM signers
        WHERE sign_task_id = ? ORDER BY position ASC`
    )
    .all(row.id) as (Omit<SignerRecord, 'concurrentRoles'> & { concurrentRoles: string | null })[];
  const signers = signerRows.map(({ concurrentRoles, ...signer }): SignerRecord => {
    const roles = concurrentRoles ? (JSON.parse(concurrentRoles) as SignerRecord['role'][]) : [];
    return roles.length > 0 ? { ...signer, concurrentRoles: roles } : signer;
  });
  return { id: row.id, taskRef: row.provider_task_ref, status: row.status, signers };
}

export function legacyProgressOf(task: LegacySignTaskRecord): SigningProgress {
  return { status: task.status, signers: task.signers, currentSigner: currentSignerOf(task) };
}

export function findLegacySubjectByTaskRef(
  db: Database.Database,
  provider: SigningProviderId,
  taskRef: string
): SigningSubject | null {
  const row = db
    .prepare('SELECT subject_type, subject_id FROM sign_tasks WHERE provider = ? AND provider_task_ref = ?')
    .get(provider, taskRef) as { subject_type: SigningSubjectType; subject_id: string } | undefined;
  return row ? { type: row.subject_type, id: row.subject_id } : null;
}

/** 回傳是否寫入。簽署標的或服務商任務編號已有簽署任務時不寫入，回 false。 */
export function insertLegacySignTask(db: Database.Database, task: NewSignTask): boolean {
  const result = db
    .prepare(
      `INSERT INTO sign_tasks (provider, provider_task_ref, subject_type, subject_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, COALESCE(?, ${NOW}), ?)
       ON CONFLICT DO NOTHING`
    )
    .run(
      task.provider,
      task.taskRef,
      task.subject.type,
      task.subject.id,
      task.status ?? 'in_progress',
      toLegacyTime(task.createdAt ?? null),
      toLegacyTime(task.updatedAt ?? null)
    );
  if (result.changes === 0) return false;

  const insertSigner = db.prepare(
    `INSERT INTO signers (sign_task_id, position, role, name, email, status, signed_at, concurrent_roles)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  task.signers.forEach((signer, position) => {
    insertSigner.run(
      result.lastInsertRowid,
      position,
      signer.role,
      signer.name,
      signer.email,
      signer.status ?? 'pending',
      toLegacyTime(signer.signedAt ?? null),
      signer.concurrentRoles?.length ? JSON.stringify(signer.concurrentRoles) : null
    );
  });
  return true;
}

export interface LegacySignTaskFile {
  id: number;
  kind: ContractFileKind;
  status: string;
  file_name: string;
  rel_path: string | null;
  byte_size: number | null;
  content_type: string | null;
  error: string | null;
  saved_at: string;
}

export function listLegacySignTaskFiles(db: Database.Database, signTaskId: number): LegacySignTaskFile[] {
  return db
    .prepare(
      `SELECT id, kind, status, file_name, rel_path, byte_size, content_type, error, saved_at
         FROM sign_task_files WHERE sign_task_id = ? ORDER BY kind`
    )
    .all(signTaskId) as LegacySignTaskFile[];
}

// 舊檔的時間是 SQLite 本地時間字串。已經是這個格式的原樣保留，ISO 格式的轉成同一種
function toLegacyTime(time: string | null): string | null {
  if (!time) return null;
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(time) ? time : dayjs(time).format('YYYY-MM-DD HH:mm:ss');
}
