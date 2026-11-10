import { getOrgName } from '../case-store/repository';
import { notify, type NotifyReceipt } from '../notifications';
import type { OrgTx } from '../pg/with-tx';

// 通知委託人（ADR-0050 決議 10、ADR-0014 決議 13）。社宅旗標修改（MIL-123）與押金持有人確認（MIL-125）共用。
//
// 委託人：案件連到的委託管理案件中，目前有效的 mandator 成員（屋主）。每位寄一封 email，寄件名義是主辦組織。
// 站內通知寫進主辦組織，由第一則帶出。案件沒有連到委託管理案件、或委託人沒有 email 時只有站內通知。
// 委託人若有自己的組織，跨組織的站內通知還沒有，現在只有 email。
// tx 是呼叫端的組織交易。通知與呼叫端的業務資料同一個交易提交或回滾。
// email 要等交易提交後，才用回傳的單據呼叫 dispatchNotificationEmail。

/** 委託人的 email：連結的委託管理案件中目前有效的 mandator 成員。 */
export async function mandatorEmails(tx: OrgTx, mandateCaseId: string): Promise<string[]> {
  const { rows } = await tx.query<{ email: string }>(
    `SELECT DISTINCT p.email
       FROM org.case_members m JOIN control.parties p ON p.id = m.party_id
      WHERE m.case_id = $1 AND m.relation = 'mandator' AND m.valid_period @> now()
      ORDER BY p.email`,
    [mandateCaseId],
  );
  return rows.map((r) => r.email);
}

export interface MandatorNotice {
  kind: string;
  title: string;
  body: string;
  linkPath: string;
}

export interface MandatorNotifyResult {
  receipts: NotifyReceipt[];
  /** 是否另寄 email 給委託人。 */
  mandatorNotified: boolean;
}

/** 租賃案件連到的委託管理案件 ID。沒有連結時是 null。 */
export async function linkedMandateCaseId(tx: OrgTx, leaseCaseId: string): Promise<string | null> {
  const { rows } = await tx.query<{ linked_mandate_case_id: string | null }>(
    `SELECT linked_mandate_case_id FROM org.cases WHERE id = $1`,
    [leaseCaseId],
  );
  return rows[0]?.linked_mandate_case_id ?? null;
}

export async function notifyMandators(tx: OrgTx, mandateCaseId: string | null, notice: MandatorNotice): Promise<MandatorNotifyResult> {
  const emails = mandateCaseId ? await mandatorEmails(tx, mandateCaseId) : [];
  if (emails.length === 0) return { receipts: [await notify(tx, notice)], mandatorNotified: false };

  const { rows } = await tx.query<{ org_id: string }>(`SELECT current_setting('app.org_id', true) AS org_id`);
  const orgName = await getOrgName(tx, rows[0].org_id);
  const from = (orgName ?? '管理公司').slice(0, 100);
  const receipts: NotifyReceipt[] = [];
  for (const [i, to] of emails.entries()) {
    receipts.push(await notify(tx, { ...notice, inApp: i === 0, email: { to, from } }));
  }
  return { receipts, mandatorNotified: true };
}
