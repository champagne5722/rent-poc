import { authorize, bindAccessContext, Forbidden } from '../authorize';
import { requestContext } from '../current-request-context';
import { withTx } from '../pg/database';
import { toDbContext } from '../request-context';
import { countUnread, listNotifications } from './index';
import { toNotificationDto, type NotificationDto } from './member-route';

// 通知清單的資料載入（MIL-179）。通知頁在 server component 呼叫它，規則與 GET /api/notifications 相同。
// 只給 server component 用；route handler 走 inMemberTx，才能把拒絕轉成 401、403 的回應。

export type NotificationListLoad =
  | { kind: 'ok'; items: NotificationDto[]; unread: number }
  // 不是組織身分，或身分沒有查看通知的權限
  | { kind: 'forbidden' };

/** 載入目前成員的通知，新的在前，最多 50 則。沒登入時丟 Unauthenticated，由頁面導向登入。 */
export async function loadNotificationList(): Promise<NotificationListLoad> {
  const rc = await requestContext();
  if (rc.kind !== 'org') return { kind: 'forbidden' };
  try {
    return await withTx(toDbContext(rc), async (tx) => {
      bindAccessContext(tx, rc);
      await authorize(tx, 'notification.read', { type: 'org' });
      const items = await listNotifications(tx, rc.partyId, {});
      return { kind: 'ok' as const, items: items.map(toNotificationDto), unread: await countUnread(tx, rc.partyId) };
    });
  } catch (error) {
    if (error instanceof Forbidden) return { kind: 'forbidden' };
    throw error;
  }
}
