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

/**
 * 同 authorize，但案件狀態不符（`state_not_allowed`）不算拒絕，回 `null`。
 *
 * 給合約生命週期的 route 用（送簽、編輯、刪除、撤回、重寄、簽署連結、補抓文件、模擬簽署）。
 * 這些 route 對「合約現在的狀態不能做這件事」有自己的 409 與訊息（例如「僅草稿可送簽」），
 * 既有行為與測試依賴它。案件有了之後，案件狀態與合約狀態同步，兩者都擋同一件事；
 * 狀態不符時身分已經通過其他全部檢查，呼叫端是合法成員，看到狀態訊息不洩漏任何東西。
 *
 * 回 `null` 時呼叫端必須繼續做自己的狀態檢查並拒絕。不可在 `null` 之後寫入。
 * 其他拒絕原因（角色、關係、`viewer` 寫入、終態唯讀、物件不存在）照舊丟 Forbidden。
 */
export async function authorizeIgnoringState(
  t: Tx,
  action: ActionId,
  object: AuthObject,
): Promise<AccessGrant | null> {
  const result = await checkAccess(t, action, object);
  if (result.allowed) return result.grant;
  if (result.forbidden.reason === 'state_not_allowed') return null;
  throw result.forbidden;
}
