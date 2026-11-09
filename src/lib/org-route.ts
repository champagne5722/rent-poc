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

/**
 * 以目前請求的組織脈絡開一個交易。沒有登入回 401，不是組織身分回 403。
 * handler 的例外原樣丟出（withTx 會回滾），由 Next.js 回 500。
 */
export async function inOrgTx(handler: (tx: OrgTx) => Promise<Response>): Promise<Response> {
  let rc;
  try {
    rc = await requestContext();
  } catch (error) {
    if (error instanceof Unauthenticated) return jsonError(401, error.message);
    throw error;
  }
  if (rc.kind !== 'org') return jsonError(403, new OrgContextRequired().message);
  return withTx(toDbContext(rc), handler);
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
  return withTx(toDbContext(org), (tx) => handler(tx, org));
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

export { readJson } from './http';
