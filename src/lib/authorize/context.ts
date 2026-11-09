import type { Tx } from '../pg/with-tx';
import type { RequestContext } from '../request-context';

// 把請求脈絡綁在交易上。authorize(t, action, object) 從 t 查回脈絡，呼叫端不必每次傳。
//
// 為什麼綁在 tx，不用全域或 AsyncLocalStorage：
// - 脈絡與交易一起產生、一起結束。org-route 用同一個 rc 開交易並綁定，兩者不會對不上。
// - authorize 不得自己呼叫 requestContext()：它會另開連線查 session，而 withTx 不得巢狀。
// - 沒綁定的交易丟程式錯誤（不是 Forbidden），不會被當成拒絕或放行。

const bound = new WeakMap<object, RequestContext>();

/** 由開交易的人呼叫：org-route 的 inOrgTx、inOrgTxAs，以及 MIL-115 的 withCaseMemberTx。 */
export function bindAccessContext(tx: Tx, rc: RequestContext): void {
  bound.set(tx, rc);
}

export function accessContextOf(tx: Tx): RequestContext {
  const rc = bound.get(tx);
  if (!rc) {
    throw new Error('這個交易沒有綁定請求脈絡：authorize() 只能在 inOrgTx、inOrgTxAs 或 withCaseMemberTx 開的交易內呼叫');
  }
  return rc;
}
