import { NextRequest } from 'next/server';
import { getProperty, insertContractWithEvent, listContracts } from '@/lib/db';
import { bindTemplate } from '@/lib/clause-library';
import { toEquipmentAnnex } from '@/lib/equipment';
import { routingInputError } from '@/lib/signature-routing';
import type { ContractFields } from '@/lib/types';

export async function GET() {
  return Response.json({ data: listContracts() });
}

// 從物件建立合約草稿：物件資料在此帶入成快照，之後與物件脫鉤（見 docs/domain-model.md）；
// 範本版本也在此綁定，選用條款在 wizard 第①步勾選後才寫進快照（ADR-0005）
export async function POST(request: NextRequest) {
  const body = await request.json();
  const property = getProperty(Number(body.property_id));
  if (!property) return Response.json({ error: '請指定有效的物件' }, { status: 400 });
  // 分流條件由建約 wizard 第一步填寫，存進欄位快照隨草稿保存（ADR-0021 決議 1）；沒帶則視為自管
  const routingError = routingInputError(body.routing);
  if (routingError) return Response.json({ error: routingError }, { status: 400 });

  const fields: ContractFields = {
    ...(body.routing ? { routing: body.routing } : {}),
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
  return Response.json({ data: { id } }, { status: 201 });
}
