import { getMailer, type Mailer } from '../mailer';
import { withTx } from '../pg/database';
import type { OrgContext, OrgTx } from '../pg/with-tx';
import {
  claimOutbox,
  completeOutbox,
  failOutbox,
  getOutbox,
  listDueOutbox,
  recoverStaleOutbox,
  type OutboxRow,
  type OutboxStatus,
} from '../signing-module/outbox';
import { EMAIL_OUTBOX_ACTION, EMAIL_SUBJECT_TYPE } from './notify';

// 提交後派送通知 email（ADR-0020 決議 5、6，MIL-120）。流程拆成「交易、寄信、交易」，交易內沒有外部呼叫（ADR-0012 決議 10）：
//   交易一：認領 outbox 列（pending 轉 sending），讀 email 列。
//   寄信：  Mailer.send。
//   交易二：成功＝email 列記寄出時間、outbox 轉 done。失敗＝依 A 線的重試規則回 pending，用完轉 dead。
// 排程重試用 drainNotificationEmails。呼叫它的 worker route 屬 MIL-86，還沒建，在那之前失敗的列只能等手動重派。
// 至少一次：寄出後交易二失敗時，列停在 sending，超過 OUTBOX_STALE_MS 被視為中斷、回 pending 後會再寄一次。

export type DispatchResult =
  | { kind: 'sent'; mailId: string }
  | { kind: 'failed'; error: string; status: OutboxStatus }
  /** 不是通知 email 的列、別的組織的列、已經派送過、別的程序正在派送。什麼都沒做。 */
  | { kind: 'skipped' };

export interface DispatchDeps {
  /** 取得 Mailer 的函式，預設 getMailer()。測試傳 Mock。 */
  mailer?: () => Mailer;
}

interface EmailRow {
  id: string;
  kind: string;
  to_email: string;
  from_name: string;
  subject: string;
  body_text: string;
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function dispatchNotificationEmail(
  orgId: string,
  outboxId: string | null,
  deps: DispatchDeps = {},
): Promise<DispatchResult> {
  if (outboxId === null) return { kind: 'skipped' };
  const ctx: OrgContext = { kind: 'org', orgId };

  const claimed = await withTx(ctx, async (tx) => {
    const existing = await getOutbox(tx, outboxId);
    if (!existing || existing.action !== EMAIL_OUTBOX_ACTION) return null;
    const row = await claimOutbox(tx, outboxId);
    if (!row) return null;
    const email = await loadEmail(tx, row);
    if (!email) {
      await failOutbox(tx, row, '找不到通知 email 的內容');
      return null;
    }
    return { row, email };
  });
  if (!claimed) return { kind: 'skipped' };
  const { row, email } = claimed;

  let mailId: string;
  try {
    const mailer = (deps.mailer ?? getMailer)();
    ({ id: mailId } = await mailer.send({
      to: email.to_email,
      from: email.from_name,
      subject: email.subject,
      text: email.body_text,
      kind: email.kind,
    }));
  } catch (e) {
    const error = errorMessage(e);
    const status = await withTx(ctx, (tx) => failOutbox(tx, row, error));
    return { kind: 'failed', error, status };
  }

  await withTx(ctx, async (tx) => {
    await tx.query(`UPDATE org.notification_emails SET sent_at = now(), mailer_message_id = $2 WHERE id = $1`, [email.id, mailId]);
    await completeOutbox(tx, row.id, { status: 'done' });
  });
  return { kind: 'sent', mailId };
}

/** 排程重試：處理一個組織到期的通知 email。一列失敗不影響其他列。組織清單由呼叫端（MIL-86 的 worker）提供。 */
export async function drainNotificationEmails(orgId: string, limit: number, deps: DispatchDeps = {}): Promise<DispatchResult[]> {
  const ctx: OrgContext = { kind: 'org', orgId };
  const due = await withTx(ctx, async (tx) => {
    await recoverStaleOutbox(tx);
    return listDueOutbox(tx, limit, [EMAIL_OUTBOX_ACTION]);
  });
  const results: DispatchResult[] = [];
  for (const row of due) {
    try {
      results.push(await dispatchNotificationEmail(orgId, row.id, deps));
    } catch (e) {
      console.error(`[notifications] 派送 outbox ${row.id} 失敗：${errorMessage(e)}`);
    }
  }
  return results;
}

async function loadEmail(tx: OrgTx, row: OutboxRow): Promise<EmailRow | null> {
  // 簽署模組把 subject.type 標成簽署標的型別。send_email 列的值是 EMAIL_SUBJECT_TYPE，所以先放寬成 string 再比對
  const subjectType: string = row.subject.type;
  if (subjectType !== EMAIL_SUBJECT_TYPE) return null;
  const { rows } = await tx.query<EmailRow>(
    `SELECT id, kind, to_email, from_name, subject, body_text FROM org.notification_emails WHERE id = $1`,
    [row.subject.id],
  );
  return rows[0] ?? null;
}
