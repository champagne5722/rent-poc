import { NextRequest } from 'next/server';
import { createContract, listContracts } from '@/lib/contracts';
import { DEFAULT_CONTRACT_TYPE, initialFieldsFor, type InitialFieldsInput } from '@/lib/contract-types';
import { inOrgTx, readJson } from '@/lib/org-route';
import { isUlid } from '@/lib/pg/ulid';
import { getProperty } from '@/lib/properties';
import { routingInputError } from '@/lib/signature-routing';
import { jsonOk, jsonError } from '@/lib/http';

export async function GET() {
  return inOrgTx(async (tx) => jsonOk({ data: await listContracts(tx) }));
}

// 從物件建立合約草稿：欄位快照由合約類型定義產生（物件資料帶入成快照、綁定範本版本，見 contract-types）。
// 目前建約入口只建租賃合約，委託管理合約的建立屬 MIL-74。
export async function POST(request: NextRequest) {
  const body = await readJson(request);
  const propertyId = typeof body === 'object' && body !== null ? (body as { property_id?: unknown }).property_id : undefined;
  if (!isUlid(propertyId)) return jsonError(400, '請指定有效的物件');
  // 分流條件由建約 wizard 第一步填寫，存進欄位快照隨草稿保存（ADR-0021 決議 1）；沒帶則視為自管
  const routing = (body as { routing?: unknown }).routing;

  // 讀物件與建合約在同一個交易。別的組織的物件與不存在的物件同樣回 400；
  // 即使讀到之後物件被刪，複合外鍵 (org_id, property_id) 也會讓建立失敗並回滾
  return inOrgTx(async (tx) => {
    const property = await getProperty(tx, propertyId);
    if (!property) return jsonError(400, '請指定有效的物件');
    const routingError = routingInputError(routing);
    if (routingError) return jsonError(400, routingError);

    const fields = initialFieldsFor(DEFAULT_CONTRACT_TYPE, {
      property,
      routing: routing as InitialFieldsInput['routing'],
    });

    // 合約、「建立」歷程事件與稽核事件同交易寫入（ADR-0007、ADR-0019）
    const id = await createContract(tx, { property_id: property.id, fields, contract_type: DEFAULT_CONTRACT_TYPE });
    return jsonOk({ data: { id } }, { status: 201 });
  });
}
