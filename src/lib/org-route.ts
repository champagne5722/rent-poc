import type { ActionId } from './access';
import { authorize, authorizeIgnoringState, bindAccessContext, Forbidden, forbiddenResponse, type AuthObject } from './authorize';
import { requestContext } from './current-request-context';
import { jsonError, jsonOk } from './http';
import { withTx } from './pg/database';
import type { OrgTx } from './pg/with-tx';
import { OrgContextRequired, Unauthenticated, toDbContext, type RequestContext } from './request-context';

// 組織範圍的 route handler 骨架（MIL-81 定下的寫法，之後的實體 route 照用）。
//
// 一個 route 做三件事：
// 1. 在交易外讀請求本文並驗證。回應格式錯誤時不佔連線。
// 2. 用 inOrgTx 開交易，callback 內只做資料庫讀寫並回傳 Response。
// 3. 別的組織的資料與不存在的資料，一律回同一個 404 本文。
// 4. 權限檢查在 callback 開頭呼叫 authorize(tx, action, object)（MIL-108）。交易已綁定請求脈絡，
//    拒絕時丟 Forbidden，這裡統一轉成 response（見 authorize/response.ts）。沒有預設組織可退。

/**
 * 以目前請求的組織脈絡開一個交易。沒有登入回 401，不是組織身分回 403。
 * handler 的例外原樣丟出（withTx 會回滾），由 Next.js 回 500。
 */
export async function inOrgTx(handler: (tx: OrgTx) => Promise<Response>): Promise<Response> {
  return inOrgTxAs((tx) => handler(tx));
}

/**
 * 同 inOrgTx，但 handler 也拿到請求脈絡（組織角色、帳號 ID）。成員管理這類要看呼叫者是誰的 route 用（MIL-106）。
 */
export async function inOrgTxAs(
  handler: (tx: OrgTx, rc: Extract<RequestContext, { kind: 'org' }>) => Promise<Response>,
): Promise<Response> {
  let rc;
  try {
    rc = await requestContext();
  } catch (error) {
    if (error instanceof Unauthenticated) return jsonError(401, error.message);
    throw error;
  }
  if (rc.kind !== 'org') return jsonError(403, new OrgContextRequired().message);
  const org = rc;
  try {
    return await withTx(toDbContext(org), (tx) => {
      // 交易與請求脈絡一起產生，authorize(tx, ...) 才查得到呼叫者是誰
      bindAccessContext(tx, org);
      return handler(tx, org);
    });
  } catch (error) {
    // withTx 已回滾。拒絕與「資料不存在」對外同一個回應（P0-02 AC1）
    if (error instanceof Forbidden) return forbiddenResponse(error);
    throw error;
  }
}

/**
 * 在組織交易內只做讀取，把結果帶出交易再處理。要做交易外的事（例如過渡期寫 SQLite）時用這個，
 * 不要把它們塞進 inOrgTx 的 callback：交易內不得有 fs 與外部 I/O（ADR-0012 決議 10）。
 */
export async function readInOrgTx<R>(
  read: (tx: OrgTx) => Promise<R>,
): Promise<{ ok: true; value: R } | { ok: false; response: Response }> {
  let result: { value: R } | undefined;
  const response = await inOrgTx(async (tx) => {
    result = { value: await read(tx) };
    return jsonOk(null);
  });
  // 沒登入或不是組織身分時不會走到 callback，response 就是 401 或 403
  return result ? { ok: true, value: result.value } : { ok: false, response };
}

/**
 * 只做權限檢查，不做別的。通過回 null，拒絕回該回應（401、403、404）。
 * 給後面要呼叫簽署模組（它自己開交易或呼叫外部服務）的 route 用：先過這一關，再進模組。
 */
export async function authorizeOnly(
  action: ActionId,
  object: AuthObject,
  options: { ignoreCaseState?: boolean } = {},
): Promise<Response | null> {
  // ignoreCaseState：合約生命週期 route 自己有狀態檢查與 409 訊息，案件狀態不符不在這裡擋（見 authorizeIgnoringState）
  const checked = await readInOrgTx((tx) =>
    options.ignoreCaseState ? authorizeIgnoringState(tx, action, object) : authorize(tx, action, object),
  );
  return checked.ok ? null : checked.response;
}

export { readJson } from './http';
