import { requestContext } from './current-request-context';
import { jsonError, jsonOk } from './http';
import { withTx } from './pg/database';
import type { OrgTx } from './pg/with-tx';
import { OrgContextRequired, Unauthenticated, toDbContext } from './request-context';

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
 * 不經 route 的呼叫端（簽署模組的訂閱者）用的組織交易。沒有登入丟 Unauthenticated，
 * 不是組織身分丟 OrgContextRequired，由呼叫端的錯誤處理轉成 401、403。
 * 過渡期的 webhook 也走這裡，org 脈絡是預設組織；C 線與 MIL-85 會改成由簽署任務查出組織。
 */
export async function runInOrgTx<R>(fn: (tx: OrgTx) => Promise<R>): Promise<R> {
  const rc = await requestContext();
  if (rc.kind !== 'org') throw new OrgContextRequired();
  return withTx(toDbContext(rc), fn);
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

/** 讀 JSON 本文。不是合法的 JSON 時回 undefined，呼叫端回 400。 */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
