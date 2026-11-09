import { NextRequest } from 'next/server';
import { getContract, getProperty } from '@/lib/db';
import { getMandateItems, replaceMandateItems } from '@/lib/mandate-schedule/repository';
import { parseMandateSelection, resolveMandateItems } from '@/lib/mandate-schedule';

type Ctx = { params: Promise<{ id: string }> };

// 委託管理合約的委託標的清單（MIL-74）。租賃單位從物件多選，名稱與地址在加入清單時快照，之後與物件脫鉤。
// GET 回目前的清單。PUT 整批取代，請求只帶租賃單位編號與委託範圍，快照由伺服器取。
export async function GET(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const contract = getContract(Number(id));
  if (!contract) return Response.json({ error: '合約不存在' }, { status: 404 });
  return Response.json({ data: { items: await getMandateItems(contract.id) } });
}

export async function PUT(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const contract = getContract(Number(id));
  if (!contract) return Response.json({ error: '合約不存在' }, { status: 404 });
  if (contract.contract_type !== 'management') {
    return Response.json({ error: '只有委託管理合約有委託標的清單' }, { status: 400 });
  }
  if (contract.status !== 'draft') {
    return Response.json({ error: '僅草稿可編輯；已送簽的合約請先撤回' }, { status: 409 });
  }
  const selection = parseMandateSelection(await request.json().catch(() => null));
  if (!selection) return Response.json({ error: '委託標的清單的格式不正確' }, { status: 400 });

  const resolved = resolveMandateItems(selection, await getMandateItems(contract.id), (propertyId) => {
    const property = getProperty(Number(propertyId));
    return property ? { name: property.name, address: property.address } : null;
  });
  if (!resolved.ok) return Response.json({ error: resolved.error }, { status: 400 });

  await replaceMandateItems(contract.id, resolved.items);
  return Response.json({ data: { items: resolved.items } });
}
