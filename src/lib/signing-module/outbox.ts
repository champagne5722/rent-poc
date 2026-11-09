import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import type { SigningSubject } from './provider';

// outbox 的儲存（ADR-0020 決議 5、6，MIL-85）。表與狀態的意義見 db/migrations/0006_sign_tasks.sql。
// 這裡只管資料列的狀態轉移，不呼叫服務商。派送在 module.ts，排程重試（drain-outbox）在 src/lib/jobs/jobs.ts（MIL-86）。

export type OutboxAction = 'create_sign_task' | 'void_sign_task' | 'resend_sign_task';
export type OutboxStatus = 'pending' | 'sending' | 'done' | 'failed' | 'dead' | 'skipped';

/** 首次派送之外最多再重試的次數。用完轉 dead，進人工處理清單（ADR-0020 決議 6）。 */
export const OUTBOX_MAX_RETRIES = 5;

/** 認領後超過這段時間沒有結果，視為派送中斷（程序終止、連線中斷）。 */
export const OUTBOX_STALE_MS = 10 * 60 * 1000;

/** 建立簽署任務失敗不自動重試：點點簽沒有冪等鍵，重試會多建任務。 */
const RETRYABLE: Record<OutboxAction, boolean> = {
  create_sign_task: false,
  void_sign_task: true,
  resend_sign_task: true,
};

export interface OutboxRow {
  id: string;
  action: OutboxAction;
  subject: SigningSubject;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  providerTaskRef: string | null;
}

interface Row {
  id: string;
  action: OutboxAction;
  subject_type: string;
  subject_id: string;
  status: OutboxStatus;
  attempts: number;
  last_error: string | null;
  provider_task_ref: string | null;
}

const COLUMNS = 'id, action, subject_type, subject_id, status, attempts, last_error, provider_task_ref';

const toRow = (r: Row): OutboxRow => ({
  id: r.id,
  action: r.action,
  subject: { type: r.subject_type, id: r.subject_id },
  status: r.status,
  attempts: r.attempts,
  lastError: r.last_error,
  providerTaskRef: r.provider_task_ref,
});

/**
 * 排一列。同一個簽署標的、同一種動作同時只有一列在進行（pending 或 sending）：
 * 已有的話不新增，回傳那一列，created 為 false。
 * 建立簽署任務直接以 sending 排入（呼叫端馬上派送，第一次派送算一次）；其餘動作以 pending 排入，之後再認領。
 */
export async function enqueueOutbox(
  tx: OrgTx,
  input: { action: OutboxAction; subject: SigningSubject; sending?: boolean },
): Promise<{ row: OutboxRow; created: boolean }> {
  const sending = input.sending === true;
  const { rows } = await tx.query<Row>(
    `INSERT INTO org.outbox (id, org_id, action, subject_type, subject_id, status, attempts, updated_at)
     VALUES ($1, current_setting('app.org_id', true), $2, $3, $4, $5, $6, now())
     ON CONFLICT DO NOTHING
     RETURNING ${COLUMNS}`,
    [newUlid(), input.action, input.subject.type, input.subject.id, sending ? 'sending' : 'pending', sending ? 1 : 0],
  );
  if (rows[0]) return { row: toRow(rows[0]), created: true };

  const open = await tx.query<Row>(
    `SELECT ${COLUMNS} FROM org.outbox
      WHERE subject_type = $1 AND subject_id = $2 AND action = $3 AND status IN ('pending', 'sending')`,
    [input.subject.type, input.subject.id, input.action],
  );
  return { row: toRow(open.rows[0]), created: false };
}

/**
 * 認領一列：pending 轉 sending，次數加一。別的交易正在處理同一列（FOR UPDATE SKIP LOCKED）、
 * 或這一列不是 pending 時回 null，呼叫端不得派送。
 */
export async function claimOutbox(tx: OrgTx, id: string): Promise<OutboxRow | null> {
  const { rows } = await tx.query<Row>(
    `UPDATE org.outbox SET status = 'sending', attempts = attempts + 1, updated_at = now()
      WHERE id = (SELECT id FROM org.outbox WHERE id = $1 AND status = 'pending' FOR UPDATE SKIP LOCKED)
      RETURNING ${COLUMNS}`,
    [id],
  );
  return rows[0] ? toRow(rows[0]) : null;
}

/** 到期的 pending 列，最舊的先。drain-outbox 逐列認領處理，一次最多 limit 列。 */
export async function listDueOutbox(tx: OrgTx, limit: number): Promise<OutboxRow[]> {
  const { rows } = await tx.query<Row>(
    `SELECT ${COLUMNS} FROM org.outbox WHERE status = 'pending' AND next_attempt_at <= now() ORDER BY id LIMIT $1`,
    [limit],
  );
  return rows.map(toRow);
}

/** 人工處理清單：重試用完的列。 */
export async function listDeadOutbox(tx: OrgTx): Promise<OutboxRow[]> {
  const { rows } = await tx.query<Row>(`SELECT ${COLUMNS} FROM org.outbox WHERE status = 'dead' ORDER BY id`);
  return rows.map(toRow);
}

export async function getOutbox(tx: OrgTx, id: string): Promise<OutboxRow | null> {
  const { rows } = await tx.query<Row>(`SELECT ${COLUMNS} FROM org.outbox WHERE id = $1`, [id]);
  return rows[0] ? toRow(rows[0]) : null;
}

/** 標記完成。providerTaskRef 在建立簽署任務成功時一併記下。 */
export async function completeOutbox(
  tx: OrgTx,
  id: string,
  result: { status: 'done' | 'skipped'; note?: string; providerTaskRef?: string },
): Promise<void> {
  await tx.query(
    `UPDATE org.outbox
        SET status = $2, last_error = $3, provider_task_ref = COALESCE($4, provider_task_ref),
            updated_at = now(), completed_at = now()
      WHERE id = $1`,
    [id, result.status, result.note ?? null, result.providerTaskRef ?? null],
  );
}

/**
 * 記一次失敗。可重試的動作還有重試次數就回 pending（等下一次派送），用完轉 dead。
 * 不可重試的動作（建立簽署任務）直接轉 failed。回傳轉成的狀態。
 */
export async function failOutbox(
  tx: OrgTx,
  row: Pick<OutboxRow, 'id' | 'action' | 'attempts'>,
  error: string,
  providerTaskRef?: string,
): Promise<OutboxStatus> {
  const status: OutboxStatus = !RETRYABLE[row.action]
    ? 'failed'
    : row.attempts > OUTBOX_MAX_RETRIES
      ? 'dead'
      : 'pending';
  await tx.query(
    `UPDATE org.outbox
        SET status = $2, last_error = $3, provider_task_ref = COALESCE($4, provider_task_ref),
            updated_at = now(), completed_at = CASE WHEN $2 = 'pending' THEN NULL ELSE now() END
      WHERE id = $1`,
    [row.id, status, error, providerTaskRef ?? null],
  );
  return status;
}

/**
 * 派送中斷的列（sending 超過 OUTBOX_STALE_MS）當成失敗處理，不再卡住同一個簽署標的的新操作。
 * 建立簽署任務的結果不明（服務商可能已建立任務），轉 failed 並寫明，由使用者重新送簽。
 * 傳 subject 時只處理那個簽署標的（送簽前順手清）；不傳時處理整個組織（排程）。
 */
export async function recoverStaleOutbox(tx: OrgTx, subject?: SigningSubject): Promise<number> {
  const { rows } = await tx.query<Row>(
    `SELECT ${COLUMNS} FROM org.outbox
      WHERE status = 'sending' AND updated_at < now() - ($1::int * interval '1 millisecond')
        AND ($2::text IS NULL OR (subject_type = $2 AND subject_id = $3))
      FOR UPDATE SKIP LOCKED`,
    [OUTBOX_STALE_MS, subject?.type ?? null, subject?.id ?? null],
  );
  for (const r of rows) {
    const error =
      r.action === 'create_sign_task'
        ? '建立簽署任務沒有回應，結果不明。服務商可能已建立任務，請確認後重新送簽'
        : '派送中斷，沒有收到結果';
    await failOutbox(tx, toRow(r), error);
  }
  return rows.length;
}
