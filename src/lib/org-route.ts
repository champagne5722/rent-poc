import { requestContext } from './current-request-context';
import { jsonError } from './http';
import { withTx } from './pg/database';
import type { OrgTx } from './pg/with-tx';
import { Unauthenticated, toDbContext } from './request-context';

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
  if (rc.kind !== 'org') return jsonError(403, '此操作需要組織身分');
  return withTx(toDbContext(rc), handler);
}

/** 讀 JSON 本文。不是合法的 JSON 時回 undefined，呼叫端回 400。 */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
