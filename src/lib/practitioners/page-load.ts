import { authorize, bindAccessContext, Forbidden } from '../authorize';
import { requestContext } from '../current-request-context';
import { withTx } from '../pg/database';
import { toDbContext } from '../request-context';
import { getPractitionerMe, type PractitionerMe } from './me';

// 「我的證書」頁的資料載入（MIL-181）。頁面在 server component 呼叫它，規則與 GET /api/practitioner/me 相同。
// 只給 server component 用；route handler 走 inOrgTxAs，才能把拒絕轉成 401、403 的回應。

export type PractitionerPageLoad =
  | ({ kind: 'ok' } & PractitionerMe)
  // 不是執業主體組織，或身分沒有查看證書的權限
  | { kind: 'forbidden' };

/** 載入本人的證書、任職與個資告知狀態。沒登入時丟 Unauthenticated，由頁面導向登入。 */
export async function loadPractitionerPage(): Promise<PractitionerPageLoad> {
  const rc = await requestContext();
  if (rc.kind !== 'org' || rc.orgKind !== 'practice') return { kind: 'forbidden' };
  try {
    return await withTx(toDbContext(rc), async (tx) => {
      bindAccessContext(tx, rc);
      await authorize(tx, 'practitioner.read', { type: 'org' });
      return { kind: 'ok' as const, ...(await getPractitionerMe(tx, rc)) };
    });
  } catch (error) {
    if (error instanceof Forbidden) return { kind: 'forbidden' };
    throw error;
  }
}
