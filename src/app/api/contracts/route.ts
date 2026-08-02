import { NextRequest } from 'next/server';
import { getProperty, insertContractWithEvent, listContracts } from '@/lib/db';
import type { ContractFields } from '@/lib/types';

export async function GET() {
  return Response.json({ data: listContracts() });
}

// 從物件建立合約草稿：物件資料在此帶入成快照，之後與物件脫鉤（見 docs/domain-model.md）
export async function POST(request: NextRequest) {
  const body = await request.json();
  const property = getProperty(Number(body.property_id));
  if (!property) return Response.json({ error: '請指定有效的物件' }, { status: 400 });

  const fields: ContractFields = {
    landlordName: '',
    landlordEmail: '',
    tenantName: '',
    tenantEmail: '',
    propertyName: property.name,
    propertyAddress: property.address,
    propertyType: property.type,
    propertySize: property.size,
    equipment: property.equipment,
    rent: property.default_rent,
    deposit: property.default_rent != null ? property.default_rent * 2 : null,
    startDate: '',
    endDate: '',
    payDay: 5,
    extra: '',
  };

  // 合約與「建立」歷程事件同交易寫入（ADR-0007）
  const id = insertContractWithEvent(
    { property_id: property.id, fields: JSON.stringify(fields) },
    { type: 'created', actor: 'landlord' }
  );
  return Response.json({ data: { id } }, { status: 201 });
}
