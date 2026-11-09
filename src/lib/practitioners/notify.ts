import type { Mailer } from '../mailer';
import type { ControlTx } from '../pg/with-tx';
import type { SupplementRequest } from './desk';

// 補件通知（MIL-111，P0-04 AC2）。核對不符時，執業人員要知道為什麼，才補得了件。
//
// 兩個管道：
// 1. 站內：我的證書頁面顯示最新一筆不符的判定理由（registry.my_practitioner() 的 last_note）。這是主要管道，一定有。
// 2. 寄信：寄給執業人員本人（帳號 email）。經 src/lib/mailer 的既有介面，kind 是 registry.practitioner_supplement_requested。
//
// E 線的通知模組（notify()）併進來後，只換這個檔案的 sendPractitionerSupplement：
// 把寄信改成 notify({ kind: 'registry.practitioner_supplement_requested', partyId, payload })，其餘呼叫端不動。
// 信件本文不放證號，只放判定理由與頁面路徑。

export const PRACTITIONER_SUPPLEMENT_MAIL_KIND = 'registry.practitioner_supplement_requested';
export const PRACTITIONER_PAGE_PATH = '/practitioner';

const LAYER_LABEL: Record<SupplementRequest['layer'], string> = {
  certificate: '證書資料',
  employment: '任職資料',
  consent: '所屬業者同意書',
};

/** 執業人員本人的 email。control 的表不掛 RLS，明確帶 party ID。 */
export async function practitionerEmail(tx: ControlTx, partyId: string): Promise<string | null> {
  const { rows } = await tx.query<{ email: string }>('SELECT email FROM control.parties WHERE id = $1', [partyId]);
  return rows[0]?.email ?? null;
}

/** 交易提交後寄。寄不出去不丟錯，站內仍看得到原因，回傳是否寄出讓呼叫端記錄。 */
export async function sendPractitionerSupplement(mailer: Mailer, to: string, request: Pick<SupplementRequest, 'layer' | 'note'>): Promise<boolean> {
  try {
    await mailer.send({
      to,
      subject: `${LAYER_LABEL[request.layer]}需要補件`,
      text: `平台營運者核對後，需要你補件。\n\n項目：${LAYER_LABEL[request.layer]}\n判定理由：${request.note}\n\n請登入租房雲端管理平台，到「我的證書」頁面（${PRACTITIONER_PAGE_PATH}）補件。`,
      kind: PRACTITIONER_SUPPLEMENT_MAIL_KIND,
    });
    return true;
  } catch (error) {
    console.error('[registry] 執業人員補件通知寄送失敗', error);
    return false;
  }
}
