import { requestContext } from '../current-request-context';
import { jsonError } from '../http';
import { withTx } from '../pg/database';
import type { OrgTx } from '../pg/with-tx';
import { OrgContextRequired, Unauthenticated, toDbContext } from '../request-context';
import type { NotificationView } from './store';

// 通知 route 與頁面共用的骨架（MIL-120）。跟 org-route.ts 的 inOrgTx 一樣開組織交易，
// 另外把目前成員的 partyId 交給 handler，通知的可見範圍要靠它判斷。

export interface Member {
  orgId: string;
  partyId: string;
}

/** 以目前請求的組織成員開交易。沒有登入回 401，不是組織身分回 403。 */
export async function inMemberTx(handler: (tx: OrgTx, member: Member) => Promise<Response>): Promise<Response> {
  let rc;
  try {
    rc = await requestContext();
  } catch (error) {
    if (error instanceof Unauthenticated) return jsonError(401, error.message);
    throw error;
  }
  if (rc.kind !== 'org') return jsonError(403, new OrgContextRequired().message);
  return withTx(toDbContext(rc), (tx) => handler(tx, { orgId: rc.orgId, partyId: rc.partyId }));
}

/** 回應與頁面用的格式：日期轉成 ISO 字串。 */
export interface NotificationDto {
  id: string;
  kind: string;
  title: string;
  body: string;
  linkPath: string | null;
  createdAt: string;
  read: boolean;
}

export const toNotificationDto = (n: NotificationView): NotificationDto => ({ ...n, createdAt: n.createdAt.toISOString() });
