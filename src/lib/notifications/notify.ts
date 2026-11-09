import { assertValidMessage } from '../mailer/types';
import { isUlid, newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import { enqueueOutbox } from '../signing-module/outbox';

// notify()：任何模組送出站內通知與 email 的唯一入口（ADR-0050 決議 12，MIL-120）。
//
// 介面的規則：
// - tx 是呼叫端的組織交易。站內通知列、email 列、outbox 列與呼叫端的業務資料同一個交易提交或回滾。
//   通知只寫進 tx 的組織。要通知別的組織，由呼叫端另開那個組織的交易。
// - notify() 不寄信。交易提交後，呼叫端呼叫 dispatchNotificationEmail(orgId, receipt.outboxId)，
//   失敗的列留在 outbox，由 drainNotificationEmails 重試（重試規則見 signing-module/outbox.ts）。
// - email.from 是寄件名義，由呼叫端決定（例如繳租提醒用該組織的名稱）。
// - 輸入不合格丟 NotifyInputError，什麼都不寫。

export interface NotifyInput {
  /** 通知種類，格式「領域.動作」，例如 `rent.overdue`。也是 email 的 Mailer kind。 */
  kind: string;
  title: string;
  body: string;
  /** 點通知要去的站內路徑，必須以 / 開頭。 */
  linkPath?: string;
  /** 站內通知的收件成員（control.parties.id）。不傳＝組織所有成員都看得到。 */
  recipientPartyId?: string;
  /** 是否寫站內通知，預設 true。只寄 email（例如寄給承租人）時傳 false。 */
  inApp?: boolean;
  /** 傳了才寫 email 列與 outbox 列。主旨與本文沒傳時取 title 與 body。 */
  email?: { to: string; from: string; subject?: string; text?: string };
}

export interface NotifyReceipt {
  notificationId: string | null;
  emailId: string | null;
  /** 提交後交給 dispatchNotificationEmail 的 outbox 列。沒有 email 時是 null。 */
  outboxId: string | null;
}

export class NotifyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotifyInputError';
  }
}

export const EMAIL_SUBJECT_TYPE = 'notification_email';
export const EMAIL_OUTBOX_ACTION = 'send_email';

function validate(input: NotifyInput): void {
  const inApp = input.inApp !== false;
  if (!inApp && !input.email) throw new NotifyInputError('至少要有一個通道：站內通知或 email');
  if (input.title.trim() === '') throw new NotifyInputError('通知標題不得為空');
  if (input.recipientPartyId !== undefined && !isUlid(input.recipientPartyId)) {
    throw new NotifyInputError('收件成員必須是 ULID');
  }
  if (input.linkPath !== undefined && !(/^\/(?!\/)/.test(input.linkPath) && !/[\\\s]/.test(input.linkPath))) {
    throw new NotifyInputError('站內連結必須是以 / 開頭的站內路徑');
  }
  // 通知種類、收件人、寄件名義、主旨、本文的規則與 Mailer 共用，只維護一份（mailer/types.ts）
  const email = input.email;
  try {
    assertValidMessage({
      kind: input.kind,
      to: email?.to ?? 'placeholder@example.com',
      from: email?.from,
      subject: email?.subject ?? input.title,
      text: email?.text ?? input.body,
    });
  } catch (e) {
    throw new NotifyInputError(e instanceof Error ? e.message : String(e));
  }
}

export async function notify(tx: OrgTx, input: NotifyInput): Promise<NotifyReceipt> {
  validate(input);
  const receipt: NotifyReceipt = { notificationId: null, emailId: null, outboxId: null };

  if (input.inApp !== false) {
    receipt.notificationId = newUlid();
    await tx.query(
      `INSERT INTO org.notifications (id, org_id, recipient_party_id, kind, title, body, link_path)
       VALUES ($1, current_setting('app.org_id', true), $2, $3, $4, $5, $6)`,
      [receipt.notificationId, input.recipientPartyId ?? null, input.kind, input.title, input.body, input.linkPath ?? null],
    );
  }

  if (input.email) {
    receipt.emailId = newUlid();
    await tx.query(
      `INSERT INTO org.notification_emails (id, org_id, notification_id, kind, to_email, from_name, subject, body_text)
       VALUES ($1, current_setting('app.org_id', true), $2, $3, $4, $5, $6, $7)`,
      [
        receipt.emailId,
        receipt.notificationId,
        input.kind,
        input.email.to,
        input.email.from,
        input.email.subject ?? input.title,
        input.email.text ?? input.body,
      ],
    );
    const { row } = await enqueueOutbox(tx, { action: EMAIL_OUTBOX_ACTION, subject: { type: EMAIL_SUBJECT_TYPE, id: receipt.emailId } });
    receipt.outboxId = row.id;
  }
  return receipt;
}
