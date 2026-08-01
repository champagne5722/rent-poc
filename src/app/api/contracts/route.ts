import { NextRequest } from 'next/server';
import { getDb, getProperty, listContracts } from '@/lib/db';
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

  const result = getDb()
    .prepare('INSERT INTO contracts (property_id, fields) VALUES (?, ?)')
    .run(property.id, JSON.stringify(fields));
  return Response.json({ data: { id: Number(result.lastInsertRowid) } }, { status: 201 });
}
