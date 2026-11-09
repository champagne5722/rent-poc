import { jsonOk } from '@/lib/http';
import { markAllRead } from '@/lib/notifications';
import { inMemberTx } from '@/lib/notifications/route';

// 全部標已讀：只動目前成員看得到的未讀（MIL-120）。
export async function POST() {
  return inMemberTx(async (tx, { partyId }) => jsonOk({ data: { marked: await markAllRead(tx, partyId) } }));
}
