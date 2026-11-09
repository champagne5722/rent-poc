import type Database from 'better-sqlite3';
import dayjs from 'dayjs';
import type { SignerRole } from '../types';
import type { CurrentSigner, SigningProviderId, SigningSubject } from './provider';

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
    -- concurrent_roles：兼任角色，角色字串的 JSON 陣列，沒有兼任時是 NULL（ADR-0018 決議 9）。
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
  `);
  // 升級前建立的表沒有這個欄位。SQLite 沒有 ADD COLUMN IF NOT EXISTS，先檢查再補。
  const columns = db.prepare('PRAGMA table_info(signers)').all() as { name: string }[];
  if (!columns.some((c) => c.name === 'concurrent_roles')) {
    db.exec('ALTER TABLE signers ADD COLUMN concurrent_roles TEXT');
  }
}

export type SignTaskStatus = 'in_progress' | 'completed' | 'declined' | 'voided';
export type SignerStatus = 'pending' | 'signed' | 'declined';

export interface SignerRecord {
  role: SignerRole;
  name: string;
  email: string;
  status: SignerStatus;
  signedAt: string | null;
  // 兼任的其他角色。沒有兼任時不帶這個欄位。
  concurrentRoles?: SignerRole[];
}

export interface SignTaskRecord {
  id: number;
  taskRef: string;
  status: SignTaskStatus;
  signers: SignerRecord[];
}

// 進度推進的輸入與輸出
export type ProgressSnapshot = Pick<SignTaskRecord, 'status' | 'signers'>;

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
  const signerRows = db
    .prepare(
      `SELECT role, name, email, status, signed_at AS "signedAt", concurrent_roles AS "concurrentRoles" FROM signers
        WHERE sign_task_id = ? ORDER BY position ASC`
    )
    .all(row.id) as SignerRow[];
  return { id: row.id, taskRef: row.provider_task_ref, status: row.status, signers: signerRows.map(toSignerRecord) };
}

type SignerRow = Omit<SignerRecord, 'concurrentRoles'> & { concurrentRoles: string | null };

function toSignerRecord({ concurrentRoles, ...signer }: SignerRow): SignerRecord {
  const roles = concurrentRoles ? (JSON.parse(concurrentRoles) as SignerRole[]) : [];
  return roles.length > 0 ? { ...signer, concurrentRoles: roles } : signer;
}

/** 簽署標的在批次結果裡的鍵。編號當字串用，簽署標的的編號改字串時（MIL-131）鍵不變。 */
export function signingSubjectKey(subject: { type: string; id: number | string }): string {
  return `${subject.type}:${String(subject.id)}`;
}

// 一次查詢帶的簽署標的上限。整頁合約遠小於這個數字，所以實際上一次查詢，超過才分批，不超過資料庫的參數上限。
const BATCH_SUBJECT_LIMIT = 400;

/**
 * 批次查簽署任務：查詢次數與簽署標的數量無關，固定是任務一次、簽署人一次（超過上限才分批）。
 * 清單用它取回整頁合約的簽署進度，不逐列查詢（MIL-72）。沒有簽署任務的簽署標的不在結果裡。
 * 搬 PostgreSQL 時（A 線）改成 `WHERE (subject_type, subject_id) = ANY(...)`，鍵的規則不變。
 */
export function findSignTasks(db: Database.Database, subjects: readonly SigningSubject[]): Map<string, SignTaskRecord> {
  const found = new Map<string, SignTaskRecord>();
  for (let i = 0; i < subjects.length; i += BATCH_SUBJECT_LIMIT) {
    const chunk = subjects.slice(i, i + BATCH_SUBJECT_LIMIT);
    const taskRows = db
      .prepare(
        `SELECT id, subject_type, subject_id, provider_task_ref, status FROM sign_tasks
          WHERE (subject_type, subject_id) IN (${chunk.map(() => '(?, ?)').join(', ')})`
      )
      .all(...chunk.flatMap((s) => [s.type, String(s.id)])) as {
      id: number;
      subject_type: string;
      subject_id: string;
      provider_task_ref: string;
      status: SignTaskStatus;
    }[];
    if (taskRows.length === 0) continue;

    const signerRows = db
      .prepare(
        `SELECT sign_task_id AS "signTaskId", role, name, email, status, signed_at AS "signedAt", concurrent_roles AS "concurrentRoles"
           FROM signers WHERE sign_task_id IN (${taskRows.map(() => '?').join(', ')})
          ORDER BY sign_task_id ASC, position ASC`
      )
      .all(...taskRows.map((t) => t.id)) as (SignerRow & { signTaskId: number })[];
    const signersByTask = new Map<number, SignerRecord[]>();
    for (const { signTaskId, ...row } of signerRows) {
      signersByTask.set(signTaskId, [...(signersByTask.get(signTaskId) ?? []), toSignerRecord(row)]);
    }
    for (const t of taskRows) {
      found.set(signingSubjectKey({ type: t.subject_type, id: t.subject_id }), {
        id: t.id,
        taskRef: t.provider_task_ref,
        status: t.status,
        signers: signersByTask.get(t.id) ?? [],
      });
    }
  }
  return found;
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
  signers: (Pick<SignerRecord, 'role' | 'name' | 'email'> &
    Partial<Pick<SignerRecord, 'status' | 'signedAt' | 'concurrentRoles'>>)[];
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
      signer.signedAt ?? null,
      signer.concurrentRoles?.length ? JSON.stringify(signer.concurrentRoles) : null
    );
  });
  return true;
}

// 寫入推進後的簽署進度。next 的簽署人順序與 task 相同，陣列索引就是 position。
// 簽署時間優先用事件時間，服務商沒有提供時用現在時間。
export function saveProgress(db: Database.Database, task: SignTaskRecord, next: ProgressSnapshot): void {
  next.signers.forEach((signer, position) => {
    if (signer.status === task.signers[position].status) return;
    db.prepare(
      `UPDATE signers
          SET status = ?, signed_at = CASE WHEN ? = 'signed' THEN COALESCE(?, ${NOW}) ELSE NULL END
        WHERE sign_task_id = ? AND position = ?`
    ).run(signer.status, signer.status, toDbTime(signer.signedAt), task.id, position);
  });
  if (next.status !== task.status) {
    db.prepare(`UPDATE sign_tasks SET status = ?, updated_at = ${NOW} WHERE id = ?`).run(next.status, task.id);
  }
}

// 轉成與 NOW 相同的格式，同一欄位才不會混用兩種時間格式
function toDbTime(time: string | null): string | null {
  return time ? dayjs(time).format('YYYY-MM-DD HH:mm:ss') : null;
}
