import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { jsonOk } from '@/lib/http';
import { countUnread, listNotifications } from '@/lib/notifications';
import { inMemberTx, toNotificationDto } from '@/lib/notifications/member-route';

// 通知清單與未讀數（MIL-120）。?unread=1 只看未讀，?limit= 限制筆數（預設 50，上限 200）。
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const limit = Number(params.get('limit'));
  return inMemberTx(async (tx, { partyId }) => {
    await authorize(tx, 'notification.read', { type: 'org' });
    const items = await listNotifications(tx, partyId, {
      unreadOnly: params.get('unread') === '1',
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    });
    return jsonOk({ data: { items: items.map(toNotificationDto), unread: await countUnread(tx, partyId) } });
  });
}
