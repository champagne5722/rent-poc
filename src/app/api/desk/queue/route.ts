import { jsonError, jsonOk } from '@/lib/http';
import { deskTicket, inOperatorTx, listQueue } from '@/lib/practice-entities';

// 審核台佇列（MIL-109）。只有平台營運者。預設列待核對項目，最久的在前，帶等待時間。

export async function GET(request: Request): Promise<Response> {
  const status = new URL(request.url).searchParams.get('status') ?? 'open';
  if (status !== 'open' && status !== 'resolved') return jsonError(400, 'status 必須是 open 或 resolved');
  return inOperatorTx(deskTicket('queue'), async (tx) => jsonOk({ data: { items: await listQueue(tx, status, new Date()) } }));
}
