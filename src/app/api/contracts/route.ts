import { NextRequest } from 'next/server';
import { insertContractWithEvent, listContracts } from '@/lib/db';
import { readInOrgTx, readJson } from '@/lib/org-route';
import { isUlid } from '@/lib/pg/ulid';
import { getProperty } from '@/lib/properties';
import { bindTemplate } from '@/lib/clause-library';
import { toEquipmentAnnex } from '@/lib/equipment';
import { routingInputError } from '@/lib/signature-routing';
import type { ContractFields } from '@/lib/types';
import { jsonOk, jsonError } from '@/lib/http';

export async function GET() {
  return jsonOk({ data: listContracts() });
}

// 從物件建立合約草稿：物件資料在此帶入成快照，之後與物件脫鉤（見 docs/domain-model.md）；
// 範本版本也在此綁定，選用條款在 wizard 第①步勾選後才寫進快照（ADR-0005）
export async function POST(request: NextRequest) {
  const body = await readJson(request);
  const propertyId = typeof body === 'object' && body !== null ? (body as { property_id?: unknown }).property_id : undefined;
  if (!isUlid(propertyId)) return jsonError(400, '請指定有效的物件');

  // 物件在 PostgreSQL，合約還在 SQLite（MIL-83 搬）。先在交易內讀物件，交易結束後再寫 SQLite，
  // 不把 SQLite 的同步寫入放進 PostgreSQL 交易（ADR-0012 決議 10）。別的組織的物件與不存在的物件同樣回 400
  const read = await readInOrgTx((tx) => getProperty(tx, propertyId));
  if (!read.ok) return read.response;
  const property = read.value;
  if (!property) return jsonError(400, '請指定有效的物件');
  if (property.archived_at) return jsonError(409, '物件已封存，不能建立合約');
  // 分流條件由建約 wizard 第一步填寫，存進欄位快照隨草稿保存（ADR-0021 決議 1）；沒帶則視為自管
  const routing = (body as { routing?: unknown }).routing;
  const routingError = routingInputError(routing);
  if (routingError) return jsonError(400, routingError);

  const fields: ContractFields = {
    ...(routing ? { routing: routing as ContractFields['routing'] } : {}),
    landlordName: '',
    landlordEmail: '',
    tenantName: '',
    tenantEmail: '',
    propertyName: property.name,
    propertyAddress: property.address,
    propertyType: property.type,
    propertySize: property.size,
    // 設備附件（ADR-0008）：物件的設備清單帶入成附件列，修繕責任預設出租方，之後逐約調整
    equipmentAnnex: toEquipmentAnnex(property.equipment),
    rent: property.default_rent,
    deposit: property.default_rent != null ? property.default_rent * 2 : null,
    startDate: '',
    endDate: '',
    payDay: 5,
    extra: '',
    ...bindTemplate(),
  };

  // 合約與「建立」歷程事件同交易寫入（ADR-0007）
  const id = insertContractWithEvent(
    { property_id: property.id, fields: JSON.stringify(fields) },
    { type: 'created', actor: 'landlord' }
  );
  return jsonOk({ data: { id } }, { status: 201 });
}
