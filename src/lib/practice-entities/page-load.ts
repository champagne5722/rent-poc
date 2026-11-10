import { authorize, bindAccessContext, Forbidden } from '../authorize';
import { requestContext } from '../current-request-context';
import { withTx } from '../pg/database';
import { listOrgEmployments, type OrgEmployment } from '../practitioners/applicant';
import { toDbContext } from '../request-context';
import { applicantMayRead, applicantMayWrite } from './access';
import { getMyRegistration, type MyRegistration } from './applicant';

// 執業主體頁的資料載入（MIL-181）。頁面在 server component 呼叫它。
// 登錄進度的規則與 GET /api/practice/registration 相同，任職清單的規則與 GET /api/practitioner/me 相同。
// 只給 server component 用；route handler 走 inOrgTxAs，才能把拒絕轉成 401、403 的回應。

export type PracticePageLoad =
  | {
      kind: 'ok';
      registration: MyRegistration | null;
      canSubmit: boolean;
      orgEmployments: OrgEmployment[];
      isAdmin: boolean;
      canWrite: boolean;
    }
  // 不是執業主體組織，或身分沒有查看登錄的權限
  | { kind: 'forbidden' };

/** 載入目前組織的登錄進度與執業人員任職。沒登入時丟 Unauthenticated，由頁面導向登入。 */
export async function loadPracticePage(): Promise<PracticePageLoad> {
  const rc = await requestContext();
  if (rc.kind !== 'org') return { kind: 'forbidden' };
  try {
    return await withTx(toDbContext(rc), async (tx) => {
      bindAccessContext(tx, rc);
      await authorize(tx, 'practice_registry.read', { type: 'org' });
      if (!applicantMayRead(rc)) return { kind: 'forbidden' as const };
      await authorize(tx, 'practitioner.read', { type: 'org' });
      const [registration, orgEmployments] = await Promise.all([getMyRegistration(tx), listOrgEmployments(tx)]);
      return {
        kind: 'ok' as const,
        registration,
        canSubmit: applicantMayWrite(rc),
        orgEmployments,
        isAdmin: rc.role === 'admin',
        canWrite: rc.role === 'admin' || rc.role === 'staff',
      };
    });
  } catch (error) {
    if (error instanceof Forbidden) return { kind: 'forbidden' };
    throw error;
  }
}
