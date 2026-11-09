import { decideAccess, type ActionId } from '../access';
import type { Tx } from '../pg/with-tx';
import { accessContextOf } from './context';
import { Forbidden } from './forbidden';
import { loadAccessFacts } from './load-facts';
import type { AccessGrant, AuthObject } from './types';

// authorize()：所有寫入與讀取的權限檢查入口（MIL-108，ADR-0023 決議 6）。
// 載入事實，交給純函式 decideAccess 判斷。之後改用 OpenFGA 或 SpiceDB，只換這個檔案（架構 4.5）。
//
// 介面的規則：
// - 在 inOrgTx、inOrgTxAs 或 withCaseMemberTx 開的交易內呼叫。其他交易丟程式錯誤。
// - 先 authorize，再讀寫資料。拒絕時丟 Forbidden，交易回滾。
// - 不寫稽核事件。拒絕的交易會整個回滾，事件也跟著消失，而且寫入會鎖住鏈頭。
//   成員被移出組織的拒絕已由 auth.membership_rejected 記錄（P0-02 AC6）。
// - 允許的結果帶 onBehalf。代操作時，呼叫端必須把它放進自己的稽核事件。

export type AccessCheck = { allowed: true; grant: AccessGrant } | { allowed: false; forbidden: Forbidden };

/** 同 authorize，但拒絕時回傳而不丟錯。成員管理這類要自己決定怎麼回應的呼叫端用。 */
export async function checkAccess(t: Tx, action: ActionId, object: AuthObject): Promise<AccessCheck> {
  const rc = accessContextOf(t);
  const loaded = await loadAccessFacts(t, rc, action, object);
  if (!loaded.ok) return { allowed: false, forbidden: new Forbidden(loaded.reason, action, object) };

  const decision = decideAccess(loaded.facts, loaded.action);
  if (!decision.allowed) return { allowed: false, forbidden: new Forbidden(decision.reason, action, object) };
  return { allowed: true, grant: { via: decision.via, onBehalf: decision.onBehalf } };
}

export async function authorize(t: Tx, action: ActionId, object: AuthObject): Promise<AccessGrant> {
  const result = await checkAccess(t, action, object);
  if (!result.allowed) throw result.forbidden;
  return result.grant;
}
