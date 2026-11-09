import { NextRequest } from 'next/server';
import { createContract, listContracts } from '@/lib/contracts';
import {
  CONTRACT_TYPES,
  DEFAULT_CONTRACT_TYPE,
  contractTypeDefinition,
  initialFieldsFor,
  type InitialFieldsInput,
} from '@/lib/contract-types';
import type { ContractType } from '@/lib/labels';
import { inOrgTx, readJson } from '@/lib/org-route';
import { isUlid } from '@/lib/pg/ulid';
import { getProperty } from '@/lib/properties';
import { routingInputError } from '@/lib/signature-routing';
import { jsonOk, jsonError } from '@/lib/http';

export async function GET() {
  return inOrgTx(async (tx) => jsonOk({ data: await listContracts(tx) }));
}

// 建立合約草稿，欄位快照由合約類型定義產生（綁定範本版本，見 contract-types）。`contract_type` 沒帶是租賃合約。
// - 租賃合約：從物件建立，物件資料帶入成快照。分流條件由建約 wizard 第一步填寫，存進欄位快照
//   隨草稿保存（ADR-0021 決議 1）；沒帶則視為自管。
// - 委託管理合約（MIL-74）：不綁單一物件，租賃單位在草稿建立後加入委託標的清單。
//   委託管理合約只存在於代管，沒有分流條件要填。
export async function POST(request: NextRequest) {
  const body = await readJson(request);
  const input = typeof body === 'object' && body !== null ? (body as { contract_type?: unknown; property_id?: unknown; routing?: unknown }) : {};
  const contractType = input.contract_type ?? DEFAULT_CONTRACT_TYPE;
  if (typeof contractType !== 'string' || !(CONTRACT_TYPES as readonly string[]).includes(contractType)) {
    return jsonError(400, '不認得的合約類型');
  }
  const type = contractType as ContractType;

  // 委託管理合約不綁單一物件：沒有物件與分流條件要讀，org.contracts.property_id 是空的
  if (!contractTypeDefinition(type).requiresProperty) {
    const fields = initialFieldsFor(type, {});
    return inOrgTx(async (tx) => {
      // 合約、「建立」歷程事件與稽核事件同交易寫入（ADR-0007、ADR-0019）
      const id = await createContract(tx, { property_id: null, fields, contract_type: type });
      return jsonOk({ data: { id } }, { status: 201 });
    });
  }

  if (!isUlid(input.property_id)) return jsonError(400, '請指定有效的物件');
  const propertyId = input.property_id;
  // 分流條件由建約 wizard 第一步填寫，存進欄位快照隨草稿保存（ADR-0021 決議 1）；沒帶則視為自管
  const routing = input.routing;

  // 讀物件與建合約在同一個交易。別的組織的物件與不存在的物件同樣回 400；
  // 即使讀到之後物件被刪，複合外鍵 (org_id, property_id) 也會讓建立失敗並回滾
  return inOrgTx(async (tx) => {
    const property = await getProperty(tx, propertyId);
    if (!property) return jsonError(400, '請指定有效的物件');
    const routingError = routingInputError(routing, type);
    if (routingError) return jsonError(400, routingError);

    const fields = initialFieldsFor(type, {
      property,
      routing: routing as InitialFieldsInput['routing'],
    });

    // 合約、「建立」歷程事件與稽核事件同交易寫入（ADR-0007、ADR-0019）
    const id = await createContract(tx, { property_id: property.id, fields, contract_type: type });
    return jsonOk({ data: { id } }, { status: 201 });
  });
}
