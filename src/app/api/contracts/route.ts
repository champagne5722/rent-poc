import { NextRequest } from 'next/server';
import { getProperty, insertContractWithEvent, listContracts } from '@/lib/db';
import { DEFAULT_CONTRACT_TYPE, initialFieldsFor } from '@/lib/contract-types';
import { routingInputError } from '@/lib/signature-routing';

export async function GET() {
  return Response.json({ data: listContracts() });
}

// 從物件建立合約草稿：欄位快照由合約類型定義產生（物件資料帶入成快照、綁定範本版本，見 contract-types）。
// 目前建約入口只建租賃合約，委託管理合約的建立屬 MIL-74。
export async function POST(request: NextRequest) {
  const body = await request.json();
  const property = getProperty(Number(body.property_id));
  if (!property) return Response.json({ error: '請指定有效的物件' }, { status: 400 });
  // 分流條件由建約 wizard 第一步填寫，存進欄位快照隨草稿保存（ADR-0021 決議 1）；沒帶則視為自管
  const routingError = routingInputError(body.routing);
  if (routingError) return Response.json({ error: routingError }, { status: 400 });

  const fields = initialFieldsFor(DEFAULT_CONTRACT_TYPE, { property, routing: body.routing });

  // 合約與「建立」歷程事件同交易寫入（ADR-0007）
  const id = insertContractWithEvent(
    { property_id: property.id, fields: JSON.stringify(fields), contract_type: DEFAULT_CONTRACT_TYPE },
    { type: 'created', actor: 'landlord' }
  );
  return Response.json({ data: { id } }, { status: 201 });
}
