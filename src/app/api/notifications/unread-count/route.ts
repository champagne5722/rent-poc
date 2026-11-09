import { jsonOk } from '@/lib/http';
import { countUnread } from '@/lib/notifications';
import { inMemberTx } from '@/lib/notifications/route';

// 殼層的未讀數徽章用，只回一個數字（MIL-120）。
export async function GET() {
  return inMemberTx(async (tx, { partyId }) => jsonOk({ data: { unread: await countUnread(tx, partyId) } }));
}
