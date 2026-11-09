import { NextRequest } from 'next/server';
import { getContract } from '@/lib/contracts';
import { contractIdOf, contractNotFound, type ContractRouteCtx } from '@/lib/contracts/route';
import { jsonError, jsonOk } from '@/lib/http';
import { getMandateItems, replaceMandateItems } from '@/lib/mandate-schedule/repository';
import { parseMandateSelection, resolveMandateItems } from '@/lib/mandate-schedule';
import { inOrgTx, readJson } from '@/lib/org-route';
import { isUlid } from '@/lib/pg/ulid';
import { getProperty } from '@/lib/properties';

// 委託管理合約的委託標的清單（MIL-74）。租賃單位從物件多選，名稱與地址在加入清單時快照，之後與物件脫鉤。
// GET 回目前的清單。PUT 整批取代，請求只帶租賃單位編號與委託範圍，快照由伺服器取。
export async function GET(_request: NextRequest, { params }: ContractRouteCtx) {
  const id = await contractIdOf(params);
  if (!id) return contractNotFound();
  return inOrgTx(async (tx) => {
    if (!(await getContract(tx, id))) return contractNotFound();
    return jsonOk({ data: { items: await getMandateItems(tx, id) } });
  });
}

export async function PUT(request: NextRequest, { params }: ContractRouteCtx) {
  const id = await contractIdOf(params);
  if (!id) return contractNotFound();
  const selection = parseMandateSelection(await readJson(request));
  return inOrgTx(async (tx) => {
    // 鎖住這一列再讀：狀態檢查和寫入之間，送簽不能插進來
    const contract = await getContract(tx, id, 'update');
    if (!contract) return contractNotFound();
    if (contract.contract_type !== 'management') return jsonError(400, '只有委託管理合約有委託標的清單');
    if (contract.status !== 'draft') return jsonError(409, '僅草稿可編輯；已送簽的合約請先撤回');
    if (!selection) return jsonError(400, '委託標的清單的格式不正確');

    const stored = await getMandateItems(tx, id);
    // 只有新加的列才向物件取快照。lookup 是同步的，所以先把新加的物件讀好
    const properties = new Map<string, { name: string; address: string }>();
    for (const pick of selection) {
      if (stored.some((i) => i.propertyId === pick.propertyId) || properties.has(pick.propertyId)) continue;
      const property = isUlid(pick.propertyId) ? await getProperty(tx, pick.propertyId) : null;
      if (property) properties.set(pick.propertyId, { name: property.name, address: property.address });
    }
    const resolved = resolveMandateItems(selection, stored, (propertyId) => properties.get(propertyId) ?? null);
    if (!resolved.ok) return jsonError(400, resolved.error);

    await replaceMandateItems(tx, id, resolved.items);
    return jsonOk({ data: { items: resolved.items } });
  });
}
