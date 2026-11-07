import type Database from 'better-sqlite3';
import type { SignerRole } from '../types';
import type { CurrentSigner, SigningEventType, SigningProviderId, SigningSubject } from './provider';

// 簽署任務與簽署人的儲存（ADR-0010 決議 2）。
// 這個檔案不 import db.ts，因為 ensureSchema() 要呼叫這裡，連線一律由呼叫端傳入。
// 之後要遷移 PostgreSQL（ADR-0012）：DML 避開 SQLite 特有語法，只有取現在時間例外，集中在 NOW。
// 建表語句沿用專案慣例的 AUTOINCREMENT，遷移時隨其他表一起改。

const NOW = "datetime('now', 'localtime')";

export function ensureSignTaskTables(db: Database.Database): void {
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

    -- 當前簽署人由資料推導：順序最前面的待簽者。電話與身分證字號不得寫入這張表。
    CREATE TABLE IF NOT EXISTS signers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sign_task_id INTEGER NOT NULL REFERENCES sign_tasks(id),
      position INTEGER NOT NULL,
      role TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      signed_at TEXT,
      UNIQUE (sign_task_id, position)
    );
  `);
}

export type SignTaskStatus = 'in_progress' | 'completed' | 'declined' | 'voided';
export type SignerStatus = 'pending' | 'signed' | 'declined';

export interface SignerRecord {
  role: SignerRole;
  name: string;
  email: string;
  status: SignerStatus;
  signedAt: string | null;
}

export interface SignTaskRecord {
  id: number;
  taskRef: string;
  status: SignTaskStatus;
  signers: SignerRecord[];
}

// 簽署進度：簽署模組回給呼叫端的樣子，不含服務商任務編號
export interface SigningProgress {
  status: SignTaskStatus;
  signers: SignerRecord[];
  currentSigner: CurrentSigner | null;
}

export function findSignTask(db: Database.Database, subject: SigningSubject): SignTaskRecord | null {
  const row = db
    .prepare(
      `SELECT id, provider_task_ref, status FROM sign_tasks
        WHERE subject_type = ? AND subject_id = ?`
    )
    .get(subject.type, String(subject.id)) as
    | { id: number; provider_task_ref: string; status: SignTaskStatus }
    | undefined;
  if (!row) return null;

  // 別名要加引號，PostgreSQL 才會保留大小寫
  const signers = db
    .prepare(
      `SELECT role, name, email, status, signed_at AS "signedAt" FROM signers
        WHERE sign_task_id = ? ORDER BY position ASC`
    )
    .all(row.id) as SignerRecord[];
  return { id: row.id, taskRef: row.provider_task_ref, status: row.status, signers };
}

// 服務商任務編號只在同一服務商內唯一，所以 webhook 比對要帶服務商
export function findSubjectByTaskRef(
  db: Database.Database,
  provider: SigningProviderId,
  taskRef: string
): SigningSubject | null {
  const row = db
    .prepare('SELECT subject_type, subject_id FROM sign_tasks WHERE provider = ? AND provider_task_ref = ?')
    .get(provider, taskRef) as { subject_type: SigningSubject['type']; subject_id: string } | undefined;
  return row ? { type: row.subject_type, id: Number(row.subject_id) } : null;
}

export function currentSignerOf(task: SignTaskRecord): CurrentSigner | null {
  if (task.status !== 'in_progress') return null;
  const next = task.signers.find((s) => s.status === 'pending');
  return next ? { role: next.role, name: next.name, email: next.email } : null;
}

export function toSigningProgress(task: SignTaskRecord): SigningProgress {
  return { status: task.status, signers: task.signers, currentSigner: currentSignerOf(task) };
}

export interface NewSignTask {
  provider: SigningProviderId;
  taskRef: string;
  subject: SigningSubject;
  status?: SignTaskStatus;
  createdAt?: string | null;
  updatedAt?: string | null;
  // 陣列順序就是簽署順序
  signers: (Pick<SignerRecord, 'role' | 'name' | 'email'> & Partial<Pick<SignerRecord, 'status' | 'signedAt'>>)[];
}

// 回傳是否寫入。簽署標的或服務商任務編號已有簽署任務時不寫入，回 false。
export function insertSignTask(db: Database.Database, task: NewSignTask): boolean {
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
      String(task.subject.id),
      task.status ?? 'in_progress',
      task.createdAt ?? null,
      task.updatedAt ?? null
    );
  if (result.changes === 0) return false;

  const insertSigner = db.prepare(
    `INSERT INTO signers (sign_task_id, position, role, name, email, status, signed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  task.signers.forEach((signer, position) => {
    insertSigner.run(
      result.lastInsertRowid,
      position,
      signer.role,
      signer.name,
      signer.email,
      signer.status ?? 'pending',
      signer.signedAt ?? null
    );
  });
  return true;
}

// 依已接受的簽署事件更新簽署進度。接受與否仍由合約狀態機判斷（decideTransition），
// 所以甲方的 signed 不會走到這裡，甲方要等全員完成才標為已簽。
// 簽署標的沒有簽署任務時不做事：簽署中卻沒有任務編號的舊合約沒有回填，仍要能撤回。
export function recordSigningEvent(db: Database.Database, subject: SigningSubject, event: SigningEventType): void {
  const task = findSignTask(db, subject);
  if (!task) return;

  switch (event) {
    case 'signed':
      setCurrentSignerStatus(db, task, 'signed');
      return;
    case 'completed':
      db.prepare(
        `UPDATE signers SET status = 'signed', signed_at = COALESCE(signed_at, ${NOW})
          WHERE sign_task_id = ? AND status <> 'signed'`
      ).run(task.id);
      setTaskStatus(db, task, 'completed');
      return;
    case 'declined':
      setCurrentSignerStatus(db, task, 'declined');
      setTaskStatus(db, task, 'declined');
      return;
    case 'voided':
      setTaskStatus(db, task, 'voided');
      return;
  }
}

function setCurrentSignerStatus(db: Database.Database, task: SignTaskRecord, status: 'signed' | 'declined'): void {
  db.prepare(
    `UPDATE signers
        SET status = ?, signed_at = CASE WHEN ? = 'signed' THEN ${NOW} ELSE NULL END
      WHERE sign_task_id = ?
        AND position = (SELECT MIN(position) FROM signers WHERE sign_task_id = ? AND status = 'pending')`
  ).run(status, status, task.id, task.id);
}

function setTaskStatus(db: Database.Database, task: SignTaskRecord, status: SignTaskStatus): void {
  db.prepare(`UPDATE sign_tasks SET status = ?, updated_at = ${NOW} WHERE id = ?`).run(status, task.id);
}
