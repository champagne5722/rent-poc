import { jsonError, jsonOk } from '@/lib/http';
import { markRead } from '@/lib/notifications';
import { inMemberTx } from '@/lib/notifications/route';

// 標一則通知已讀（MIL-120）。別的組織的、別人的個人通知、不存在的，一律回同一個 404。
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inMemberTx(async (tx, { partyId }) =>
    (await markRead(tx, id, partyId)) ? jsonOk({ data: { id } }) : jsonError(404, '找不到這則通知'),
  );
}
