import type { Mailer } from '../mailer';
import type { ControlTx } from '../pg/with-tx';

// 補件通知（MIL-109，ADR-0017 決議 4）。核對不符時，執業主體要知道為什麼，才補得了件。
//
// 兩個管道：
// 1. 站內：執業主體頁面顯示最新一筆不符的判定理由（registry.my_registration() 的 last_note）。這是主要管道，一定有。
// 2. 寄信：寄給組織的 admin。經 src/lib/mailer 的既有介面，kind 是 registry.supplement_requested。
//
// E 線的通知模組（notify()）併進來後，只換這個檔案的 sendSupplementRequested：
// 把寄信改成 notify({ kind: 'registry.supplement_requested', orgId, payload })，其餘呼叫端不動。
// 信件本文不放證字號、統編，只放判定理由與頁面路徑。

export const SUPPLEMENT_MAIL_KIND = 'registry.supplement_requested';
export const PRACTICE_PAGE_PATH = '/practice';

/** 組織 admin 的 email。control 的表不掛 RLS，明確帶 org_id。 */
export async function adminRecipients(tx: ControlTx, orgId: string): Promise<string[]> {
  const { rows } = await tx.query<{ email: string }>(
    `SELECT p.email FROM control.org_memberships m
       JOIN control.users u ON u.id = m.user_id
       JOIN control.parties p ON p.id = u.party_id
      WHERE m.org_id = $1 AND m.role = 'admin' ORDER BY m.created_at, m.id`,
    [orgId],
  );
  return rows.map((r) => r.email);
}

/**
 * 寄補件通知。交易提交後呼叫（寄信是外部呼叫）。寄不出去不丟錯，站內仍看得到原因，回傳失敗數讓呼叫端記錄。
 */
export async function sendSupplementRequested(
  mailer: Mailer,
  recipients: readonly string[],
  note: string,
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const to of recipients) {
    try {
      await mailer.send({
        to,
        subject: '執業主體登錄需要補件',
        text: `平台營運者核對後，需要你補件。\n\n判定理由：${note}\n\n請登入租房雲端管理平台，到「執業主體」頁面（${PRACTICE_PAGE_PATH}）補件。`,
        kind: SUPPLEMENT_MAIL_KIND,
      });
      sent += 1;
    } catch (error) {
      failed += 1;
      console.error('[registry] 補件通知寄送失敗', error);
    }
  }
  return { sent, failed };
}
