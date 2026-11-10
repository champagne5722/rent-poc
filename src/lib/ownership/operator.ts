import { PLATFORM_ORG_ID } from '../auth/config';
import { requestContext } from '../current-request-context';
import { jsonError } from '../http';
import { withTx } from '../pg/database';
import type { OrgTx } from '../pg/with-tx';
import { Unauthenticated, type RequestContext } from '../request-context';
import type { OperatorRuns } from './desk';

// 審核台出租權源 route 的交易入口（MIL-201）。只有平台營運者身分能進。
// 兩種交易（見 desk.ts）：platform 用平台組織的 operator 脈絡，inOrg 用登錄方組織的 operator 脈絡（ADR-0026 決議 7）。
// 沒登入回 401，不是營運者身分回 403。

export type OwnershipOperator = { ok: true; rc: Extract<RequestContext, { kind: 'operator' }>; runs: OperatorRuns } | { ok: false; response: Response };

export async function requireOwnershipOperator(): Promise<OwnershipOperator> {
  let rc: RequestContext;
  try {
    rc = await requestContext();
  } catch (error) {
    if (error instanceof Unauthenticated) return { ok: false, response: jsonError(401, error.message) };
    throw error;
  }
  if (rc.kind !== 'operator') return { ok: false, response: jsonError(403, '只有平台營運者能使用審核台') };
  return { ok: true, rc, runs: operatorRuns(rc) };
}

/** 營運者身分的兩種交易。route 與 server component 共用。 */
export function operatorRuns(operator: Extract<RequestContext, { kind: 'operator' }>): OperatorRuns {
  return {
    platform: (ticketId, fn) => withTx({ kind: 'operator', operatorId: operator.userId, orgId: PLATFORM_ORG_ID, ticketId }, (tx) => fn(tx as OrgTx)),
    inOrg: (orgId, ticketId, fn) => withTx({ kind: 'operator', operatorId: operator.userId, orgId, ticketId }, (tx) => fn(tx as OrgTx)),
  };
}
