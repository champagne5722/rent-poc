import { PLATFORM_ORG_ID } from '../auth/config';
import { requestContext } from '../current-request-context';
import { jsonError } from '../http';
import { withTx } from '../pg/database';
import type { OrgTx } from '../pg/with-tx';
import type { OperatorRun } from './flows';
import { Unauthenticated, type RequestContext } from '../request-context';

// 審核台 route 的交易入口（MIL-109）。只有平台營運者身分能進。
//
// 交易用 operator 脈絡：app.org_id 是平台組織，app.operator_id 是營運者的帳號 ID，並帶工單號。
// 結果：稽核事件（含 withTx 自動寫的 operator.access）都在平台組織的鏈，行為者是營運者，
// 資料庫函式的 assert_operator() 也靠這兩個設定判斷（ADR-0012 決議 5，ADR-0019）。
// 工單號由審核台的動作決定，格式見 withTx 的 TICKET_PATTERN。

export type OperatorRequestContext = Extract<RequestContext, { kind: 'operator' }>;

export { deskTicket } from './ticket';

/** 沒登入回 401，不是營運者身分回 403。handler 的例外原樣丟出（交易回滾）。 */
export async function inOperatorTx(
  ticketId: string,
  handler: (tx: OrgTx, rc: OperatorRequestContext) => Promise<Response>,
): Promise<Response> {
  let rc: RequestContext;
  try {
    rc = await requestContext();
  } catch (error) {
    if (error instanceof Unauthenticated) return jsonError(401, error.message);
    throw error;
  }
  if (rc.kind !== 'operator') return jsonError(403, '只有平台營運者能使用審核台');
  const operator = rc;
  return withTx({ kind: 'operator', operatorId: operator.userId, orgId: PLATFORM_ORG_ID, ticketId }, (tx) => handler(tx, operator));
}

/**
 * 取得營運者身分與「開交易」的函式，給一個 route 要開多個交易的流程用（核對後刪檔、寄信）。
 * 沒登入回 401，不是營運者身分回 403。
 */
export async function requireOperator(): Promise<{ ok: true; rc: OperatorRequestContext; run: OperatorRun } | { ok: false; response: Response }> {
  let rc: RequestContext;
  try {
    rc = await requestContext();
  } catch (error) {
    if (error instanceof Unauthenticated) return { ok: false, response: jsonError(401, error.message) };
    throw error;
  }
  if (rc.kind !== 'operator') return { ok: false, response: jsonError(403, '只有平台營運者能使用審核台') };
  const operator = rc;
  const run: OperatorRun = (ticketId, fn) =>
    withTx({ kind: 'operator', operatorId: operator.userId, orgId: PLATFORM_ORG_ID, ticketId }, (tx) => fn(tx as OrgTx));
  return { ok: true, rc: operator, run };
}
