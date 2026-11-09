import { newUlid } from '../pg/ulid';
import type { ControlTx, Tx } from '../pg/with-tx';
import type { SigningEvent, SigningEventType, SigningProviderId } from './provider';

// webhook 的 inbox 儲存（ADR-0020 決議 5、9，MIL-86）。表與狀態的意義見 db/migrations/0007_inbox_jobs.sql。
// 這裡只管資料列的狀態轉移，不套用事件。處理在 module.ts，排程重試（drain-inbox）在 src/lib/jobs。

export type InboxStatus = 'pending' | 'processing' | 'done' | 'ignored' | 'dead';

/** 首次處理之外最多再重試的次數。用完轉 dead，進人工處理清單（ADR-0020 決議 6）。 */
export const INBOX_MAX_RETRIES = 5;

/** 認領後超過這段時間沒有結果，視為處理中斷（程序終止、連線中斷）。 */
export const INBOX_STALE_MS = 10 * 60 * 1000;

export interface InboxRow {
  id: string;
  provider: SigningProviderId;
  taskRef: string;
  event: SigningEvent;
  status: InboxStatus;
  attempts: number;
  lastError: string | null;
}

interface Row {
  id: string;
  provider: SigningProviderId;
  provider_task_ref: string;
  event_type: SigningEventType;
  event_email: string | null;
  event_reason: string | null;
  occurred_at: Date | string | null;
  status: InboxStatus;
  attempts: number;
  last_error: string | null;
}

const COLUMNS =
  'id, provider, provider_task_ref, event_type, event_email, event_reason, occurred_at, status, attempts, last_error';

const toRow = (r: Row): InboxRow => {
  const event: SigningEvent = { type: r.event_type };
  if (r.event_email !== null) event.email = r.event_email;
  if (r.event_reason !== null) event.reason = r.event_reason;
  if (r.occurred_at !== null) event.occurredAt = new Date(r.occurred_at).toISOString();
  return {
    id: r.id,
    provider: r.provider,
    taskRef: r.provider_task_ref,
    event,
    status: r.status,
    attempts: r.attempts,
    lastError: r.last_error,
  };
};

/**
 * 寫入一個標準化的事件。相同服務商與 body 雜湊（服務商重送的 body 一字不差）只留第一次：
 * 已存在時不新增，created 為 false。原始 body 不寫入，呼叫端只傳雜湊。
 */
export async function insertInbox(
  tx: ControlTx,
  input: { provider: SigningProviderId; bodySha256: string; taskRef: string; event: SigningEvent },
): Promise<{ id: string; created: boolean }> {
  const id = newUlid();
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO control.inbox_messages
       (id, provider, body_sha256, provider_task_ref, event_type, event_email, event_reason, occurred_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (provider, body_sha256) DO NOTHING
     RETURNING id`,
    [
      id,
      input.provider,
      input.bodySha256,
      input.taskRef,
      input.event.type,
      input.event.email ?? null,
      input.event.reason ?? null,
      input.event.occurredAt ?? null,
    ],
  );
  return rows[0] ? { id, created: true } : { id: '', created: false };
}

/**
 * 認領一列：pending 轉 processing，次數加一。回 null 的情況，呼叫端不得處理：
 * - 別的交易正在認領同一列（FOR UPDATE SKIP LOCKED），或這一列不是 pending。
 * - 同一個服務商任務有較早的事件還沒處理完（pending 或 processing）。事件要依到達順序套用，
 *   否則較晚的「第二位簽署」會先到而被 email 守門永久忽略（ADR-0010 決議 9）。等待不算一次處理。
 */
export async function claimInbox(tx: ControlTx, id: string): Promise<InboxRow | null> {
  const { rows } = await tx.query<Row>(
    `UPDATE control.inbox_messages
        SET status = 'processing', attempts = attempts + 1, updated_at = now()
      WHERE id = (
        SELECT c.id FROM control.inbox_messages c
         WHERE c.id = $1 AND c.status = 'pending'
           AND NOT EXISTS (
             SELECT 1 FROM control.inbox_messages e
              WHERE e.provider = c.provider AND e.provider_task_ref = c.provider_task_ref
                AND e.status IN ('pending', 'processing') AND e.id < c.id
           )
           FOR UPDATE OF c SKIP LOCKED
      )
      RETURNING ${COLUMNS}`,
    [id],
  );
  return rows[0] ? toRow(rows[0]) : null;
}

/** 待處理的列，最舊的先。drain-inbox 逐列認領，一次最多 limit 列。 */
export async function listPendingInbox(
  tx: ControlTx,
  provider: SigningProviderId,
  limit: number,
): Promise<Array<Pick<InboxRow, 'id'>>> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM control.inbox_messages WHERE provider = $1 AND status = 'pending' ORDER BY id LIMIT $2`,
    [provider, limit],
  );
  return rows;
}

/** 人工處理清單：重試用完的列。 */
export async function listDeadInbox(tx: ControlTx): Promise<InboxRow[]> {
  const { rows } = await tx.query<Row>(`SELECT ${COLUMNS} FROM control.inbox_messages WHERE status = 'dead' ORDER BY id`);
  return rows.map(toRow);
}

export async function getInbox(tx: ControlTx, id: string): Promise<InboxRow | null> {
  const { rows } = await tx.query<Row>(`SELECT ${COLUMNS} FROM control.inbox_messages WHERE id = $1`, [id]);
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * 標記處理結果。可以在組織交易內呼叫（app_rw 對這張 control 表有 UPDATE），
 * 這樣事件的效果與「已處理」同一個交易提交，不會只做一半。
 */
export async function finishInbox(
  tx: Pick<Tx, 'query'>,
  id: string,
  result: { status: 'done' | 'ignored'; note?: string },
): Promise<void> {
  await tx.query(
    `UPDATE control.inbox_messages
        SET status = $2, last_error = $3, updated_at = now(), processed_at = now()
      WHERE id = $1`,
    [id, result.status, result.note ?? null],
  );
}

/**
 * 記一次失敗。還有重試次數就回 pending（等下一次排程），用完轉 dead。回傳轉成的狀態。
 * 找不到路由列也走這條：建立任務的交易可能還沒提交，等下次再看，但不能永遠等。
 */
export async function failInbox(
  tx: ControlTx,
  row: Pick<InboxRow, 'id' | 'attempts'>,
  error: string,
): Promise<InboxStatus> {
  const status: InboxStatus = row.attempts > INBOX_MAX_RETRIES ? 'dead' : 'pending';
  await tx.query(
    `UPDATE control.inbox_messages
        SET status = $2, last_error = $3, updated_at = now(),
            processed_at = CASE WHEN $2 = 'dead' THEN now() ELSE NULL END
      WHERE id = $1`,
    [row.id, status, error],
  );
  return status;
}

/** processing 超過期限的列當成失敗處理，排程才會再撿起來。 */
export async function recoverStaleInbox(tx: ControlTx): Promise<number> {
  const { rows } = await tx.query<Row>(
    `SELECT ${COLUMNS} FROM control.inbox_messages
      WHERE status = 'processing' AND updated_at < now() - ($1::int * interval '1 millisecond')
      FOR UPDATE SKIP LOCKED`,
    [INBOX_STALE_MS],
  );
  for (const r of rows) await failInbox(tx, toRow(r), '處理中斷，沒有收到結果');
  return rows.length;
}
