import { bindAccessContext, Forbidden, forbiddenResponse } from '../authorize';
import { withTx } from '../pg/database';
import type { OrgTx } from '../pg/with-tx';
import { toDbContext, type RequestContext } from '../request-context';

// 屋主連結的 claim route 專用。claim 的請求脈絡不是 requestContext()：帳號第一次打開連結時還沒有組織，
// 要先建屋主組織，session 才有組織身分。所以 route 自己用 session token 解析請求脈絡，再用這裡開組織交易。
// 寫法與 org-route 的 inOrgTxAs 相同：交易綁定請求脈絡，authorize(tx, ...) 才查得到呼叫者是誰；拒絕轉成統一的回應。

export async function inOrgTxFor(
  rc: Extract<RequestContext, { kind: 'org' }>,
  handler: (tx: OrgTx) => Promise<Response>,
): Promise<Response> {
  try {
    return await withTx(toDbContext(rc), (tx) => {
      bindAccessContext(tx, rc);
      return handler(tx);
    });
  } catch (error) {
    if (error instanceof Forbidden) return forbiddenResponse(error);
    throw error;
  }
}
