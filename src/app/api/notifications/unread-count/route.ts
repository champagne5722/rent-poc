import { jsonOk } from '@/lib/http';
import { authorize } from '@/lib/authorize';
import { countUnread } from '@/lib/notifications';
import { inMemberTx } from '@/lib/notifications/member-route';

// 殼層的未讀數徽章用，只回一個數字（MIL-120）。
export async function GET() {
  return inMemberTx(async (tx, { partyId }) => {
    await authorize(tx, 'notification.read', { type: 'org' });
    return jsonOk({ data: { unread: await countUnread(tx, partyId) } });
  });
}
