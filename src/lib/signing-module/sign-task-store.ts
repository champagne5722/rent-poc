import { newUlid } from '../pg/ulid';
import type { ControlTx, OrgTx } from '../pg/with-tx';
import type { SignerRole } from '../types';
import type { CurrentSigner, SigningProviderId, SigningSubject, SigningSubjectType } from './provider';

// 簽署任務與簽署人的儲存（ADR-0010 決議 2，MIL-85 搬進 PostgreSQL）。表見 db/migrations/0006_sign_tasks.sql。
//
// 形狀照 src/lib/contracts/repository.ts：第一個參數是 withTx 給的 tx，不傳 org_id。
// INSERT 取交易的 app.org_id，查詢靠 RLS 篩選，別的組織的簽署任務和不存在的沒有差別。
// 簽署任務的 ID 是 ULID，subject_id 存簽署標的的 ULID。

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
  id: string;
  provider: SigningProviderId;
  taskRef: string;
  subject: SigningSubject;
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

interface TaskRow {
  id: string;
  provider: SigningProviderId;
  provider_task_ref: string;
  subject_type: SigningSubjectType;
  subject_id: string;
  status: SignTaskStatus;
}

interface SignerRow {
  role: SignerRole;
  name: string;
  email: string;
  status: SignerStatus;
  signed_at: Date | null;
  concurrent_roles: SignerRole[] | null;
}

const TASK_COLUMNS = 'id, provider, provider_task_ref, subject_type, subject_id, status';

async function toRecord(tx: OrgTx, row: TaskRow): Promise<SignTaskRecord> {
  const { rows } = await tx.query<SignerRow>(
    `SELECT role, name, email, status, signed_at, concurrent_roles FROM org.signers
      WHERE sign_task_id = $1 ORDER BY position ASC`,
    [row.id],
  );
  const signers = rows.map(({ concurrent_roles, signed_at, ...signer }): SignerRecord => {
    const base = { ...signer, signedAt: signed_at ? signed_at.toISOString() : null };
    return concurrent_roles && concurrent_roles.length > 0 ? { ...base, concurrentRoles: concurrent_roles } : base;
  });
  return {
    id: row.id,
    provider: row.provider,
    taskRef: row.provider_task_ref,
    subject: { type: row.subject_type, id: row.subject_id },
    status: row.status,
    signers,
  };
}

/**
 * 讀簽署標的的簽署任務。要在同一個交易改進度時傳 lock：鎖住任務列，
 * 同一個任務的兩個事件（webhook 重送）依序處理，後到的看得到先到的結果。
 */
export async function findSignTask(
  tx: OrgTx,
  subject: SigningSubject,
  options: { lock?: boolean } = {},
): Promise<SignTaskRecord | null> {
  const { rows } = await tx.query<TaskRow>(
    `SELECT ${TASK_COLUMNS} FROM org.sign_tasks WHERE subject_type = $1 AND subject_id = $2${options.lock ? ' FOR UPDATE' : ''}`,
    [subject.type, subject.id],
  );
  return rows[0] ? toRecord(tx, rows[0]) : null;
}

/** 服務商任務編號只在同一服務商內唯一，所以比對要帶服務商。webhook 查到組織之後用它找簽署任務。 */
export async function findSignTaskByRef(
  tx: OrgTx,
  provider: SigningProviderId,
  taskRef: string,
): Promise<SignTaskRecord | null> {
  const { rows } = await tx.query<TaskRow>(
    `SELECT ${TASK_COLUMNS} FROM org.sign_tasks WHERE provider = $1 AND provider_task_ref = $2`,
    [provider, taskRef],
  );
  return rows[0] ? toRecord(tx, rows[0]) : null;
}

/**
 * webhook 沒有組織脈絡：用 control 脈絡查路由列，取得 org_id 再開組織交易（ADR-0012 決議 5）。
 * 路由列由 insertSignTask 與簽署任務同交易寫入。
 */
export async function findSignTaskRoute(
  tx: ControlTx,
  provider: SigningProviderId,
  taskRef: string,
): Promise<{ orgId: string; signTaskId: string } | null> {
  const { rows } = await tx.query<{ org_id: string; sign_task_id: string }>(
    'SELECT org_id, sign_task_id FROM control.sign_task_routes WHERE provider = $1 AND provider_task_ref = $2',
    [provider, taskRef],
  );
  return rows[0] ? { orgId: rows[0].org_id, signTaskId: rows[0].sign_task_id } : null;
}

export function currentSignerOf(task: Pick<SignTaskRecord, 'status' | 'signers'>): CurrentSigner | null {
  if (task.status !== 'in_progress') return null;
  const next = task.signers.find((s) => s.status === 'pending');
  return next ? { role: next.role, name: next.name, email: next.email } : null;
}

export function toSigningProgress(task: Pick<SignTaskRecord, 'status' | 'signers'>): SigningProgress {
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

/**
 * 寫入簽署任務、簽署人與路由列。回傳是否寫入。
 * 簽署標的或服務商任務編號已有簽署任務時回 false。
 * 路由列撞號（別的組織已用這個服務商任務編號）時，簽署任務與簽署人已寫入但路由列沒有，也回 false。
 * 回 false 時呼叫端必須丟例外讓交易回滾，不得提交。
 */
export async function insertSignTask(tx: OrgTx, task: NewSignTask): Promise<boolean> {
  const id = newUlid();
  const inserted = await tx.query(
    `INSERT INTO org.sign_tasks (id, org_id, provider, provider_task_ref, subject_type, subject_id, status, created_at, updated_at)
     VALUES ($1, current_setting('app.org_id', true), $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()), $8::timestamptz)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      id,
      task.provider,
      task.taskRef,
      task.subject.type,
      task.subject.id,
      task.status ?? 'in_progress',
      task.createdAt ?? null,
      task.updatedAt ?? null,
    ],
  );
  if (inserted.rows.length === 0) return false;

  for (const [position, signer] of task.signers.entries()) {
    await tx.query(
      `INSERT INTO org.signers (id, org_id, sign_task_id, position, role, name, email, status, signed_at, concurrent_roles)
       VALUES ($1, current_setting('app.org_id', true), $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::jsonb)`,
      [
        newUlid(),
        id,
        position,
        signer.role,
        signer.name,
        signer.email,
        signer.status ?? 'pending',
        signer.signedAt ?? null,
        signer.concurrentRoles?.length ? JSON.stringify(signer.concurrentRoles) : null,
      ],
    );
  }

  const route = await tx.query(
    `INSERT INTO control.sign_task_routes (provider, provider_task_ref, org_id, sign_task_id)
     VALUES ($1, $2, current_setting('app.org_id', true), $3)
     ON CONFLICT DO NOTHING
     RETURNING sign_task_id`,
    [task.provider, task.taskRef, id],
  );
  return route.rows.length > 0;
}

/**
 * 寫入推進後的簽署進度。next 的簽署人順序與 task 相同，陣列索引就是 position。
 * 簽署時間優先用事件時間，服務商沒有提供時用現在時間。
 */
export async function saveProgress(tx: OrgTx, task: SignTaskRecord, next: ProgressSnapshot): Promise<void> {
  for (const [position, signer] of next.signers.entries()) {
    if (signer.status === task.signers[position].status) continue;
    await tx.query(
      `UPDATE org.signers
          SET status = $1, signed_at = CASE WHEN $1 = 'signed' THEN COALESCE($2::timestamptz, now()) ELSE NULL END
        WHERE sign_task_id = $3 AND position = $4`,
      [signer.status, signer.signedAt, task.id, position],
    );
  }
  if (next.status !== task.status) {
    await tx.query('UPDATE org.sign_tasks SET status = $1, updated_at = now() WHERE id = $2', [next.status, task.id]);
  }
}
