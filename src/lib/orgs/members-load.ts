import { authorize, bindAccessContext, Forbidden } from '../authorize';
import { requestContext } from '../current-request-context';
import { withTx } from '../pg/database';
import { toDbContext, type OrgRole } from '../request-context';
import { listMembers, type MemberList } from './members';

// 成員設定頁的資料載入（MIL-181）。頁面在 server component 呼叫它，規則與 GET /api/org/members 相同。
// 只給 server component 用；route handler 走 inOrgTxAs，才能把拒絕轉成 401、403 的回應。

export type MemberPageLoad =
  | ({ kind: 'ok'; me: { userId: string; role: OrgRole } } & MemberList)
  // 不是組織身分，或身分沒有查看成員的權限
  | { kind: 'forbidden' };

/** 載入目前組織的成員與待處理的邀請。沒登入時丟 Unauthenticated，由頁面導向登入。 */
export async function loadMemberPage(): Promise<MemberPageLoad> {
  const rc = await requestContext();
  if (rc.kind !== 'org') return { kind: 'forbidden' };
  try {
    return await withTx(toDbContext(rc), async (tx) => {
      bindAccessContext(tx, rc);
      await authorize(tx, 'org_member.read', { type: 'org' });
      return { kind: 'ok' as const, ...(await listMembers(tx, rc)), me: { userId: rc.userId, role: rc.role } };
    });
  } catch (error) {
    if (error instanceof Forbidden) return { kind: 'forbidden' };
    throw error;
  }
}
