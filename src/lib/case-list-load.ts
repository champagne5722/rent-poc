import { authorize, bindAccessContext, Forbidden } from './authorize';
import { listCaseSummaries, type CaseSummary } from './case-store';
import { requestContext } from './current-request-context';
import { withTx } from './pg/database';
import { toDbContext } from './request-context';

// 案件列表的資料載入（MIL-184）。列表頁在 server component 呼叫它，GET /api/cases 的內容相同。
// 目前組織主辦的案件，加上自己是成員的別組織案件。isHost 讓畫面分出「本組織主辦」與「我是成員」。

export type CaseListRow = CaseSummary & { isHost: boolean };

export type CaseListLoad =
  | { kind: 'ok'; rows: CaseListRow[] }
  // 不是組織身分，或身分沒有列出案件的權限
  | { kind: 'forbidden' };

/**
 * 載入案件列表。沒登入時丟 Unauthenticated，由頁面導向登入。
 * 只給 server component 用；route handler 走 inOrgTxAs，才能把拒絕轉成 401、403 的回應。
 */
export async function loadCaseList(): Promise<CaseListLoad> {
  const rc = await requestContext();
  if (rc.kind !== 'org') return { kind: 'forbidden' };
  try {
    const rows = await withTx(toDbContext(rc), async (tx) => {
      bindAccessContext(tx, rc);
      await authorize(tx, 'case.list', { type: 'org' });
      return listCaseSummaries(tx);
    });
    return { kind: 'ok', rows: rows.map((row) => ({ ...row, isHost: row.orgId === rc.orgId })) };
  } catch (error) {
    if (error instanceof Forbidden) return { kind: 'forbidden' };
    throw error;
  }
}
