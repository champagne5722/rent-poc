import { requestContext } from '../current-request-context';
import { withTx } from '../pg/database';
import type { ControlTx, OrgContext, OrgTx } from '../pg/with-tx';
import { OrgContextRequired, toDbContext } from '../request-context';

// 簽署模組取得資料庫交易的入口。模組的每個操作拆成「交易、外部呼叫、交易」，
// 交易內不得有外部 API 呼叫（ADR-0012 決議 10），所以模組自己決定何時開交易，呼叫端不傳 tx。
//
// 三種進入點：
// - requestOrg：目前請求的組織脈絡，route 呼叫模組時用。沒有登入丟 Unauthenticated，不是組織身分丟 OrgContextRequired。
// - inOrg：指定組織。webhook 與排程的 job 用，組織由 control.sign_task_routes 或任務認領表查出。
// - inControl：沒有組織脈絡，只能讀寫 control 的表（查路由列）。
export interface SigningDb {
  requestOrg(): Promise<OrgContext>;
  inOrg<R>(ctx: OrgContext, fn: (tx: OrgTx) => Promise<R>): Promise<R>;
  inControl<R>(fn: (tx: ControlTx) => Promise<R>): Promise<R>;
}

export const defaultSigningDb: SigningDb = {
  async requestOrg() {
    const rc = await requestContext();
    if (rc.kind !== 'org') throw new OrgContextRequired();
    return toDbContext(rc);
  },
  inOrg: (ctx, fn) => withTx(ctx, fn),
  inControl: (fn) => withTx({ kind: 'control' }, fn),
};
