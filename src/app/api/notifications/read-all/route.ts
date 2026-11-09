import { jsonOk } from '@/lib/http';
import { authorize } from '@/lib/authorize';
import { markAllRead } from '@/lib/notifications';
import { inMemberTx } from '@/lib/notifications/member-route';

// 全部標已讀：只動目前成員看得到的未讀（MIL-120）。
export async function POST() {
  return inMemberTx(async (tx, { partyId }) => {
    await authorize(tx, 'notification.mark_read', { type: 'org' });
    return jsonOk({ data: { marked: await markAllRead(tx, partyId) } });
  });
}
