import { authorize } from '@/lib/authorize';
import { jsonOk } from '@/lib/http';
import { inOrgTxAs } from '@/lib/org-route';
import { listHolderCandidates } from '@/lib/payment-accounts';

// 收款帳戶持有人的選單（MIL-187）。選項是本組織的成員與本組織案件的成員，
// 每人只有 partyId 與 displayName，不回 email 與其他個資。
// selfPartyId 是目前登入者，給表單預設選取。登入者不在清單內時為 null。
// 選單只有能登錄或修改收款帳戶的人用得到，所以權限跟登錄一樣（payment_account.manage），
// 不開給 viewer：案件成員的姓名不必給只讀角色。

export async function GET() {
  return inOrgTxAs(async (tx, rc) => {
    await authorize(tx, 'payment_account.manage', { type: 'org' });
    const candidates = await listHolderCandidates(tx);
    const selfPartyId = candidates.some((c) => c.partyId === rc.partyId) ? rc.partyId : null;
    return jsonOk({ data: candidates, selfPartyId });
  });
}
