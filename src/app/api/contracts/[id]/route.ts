import { NextRequest } from 'next/server';
import { deleteContractWithEvents, getContract, getContractRelations, getDb } from '@/lib/db';

type Ctx = { params: Promise<{ id: string }> };

// 詳情頁一次取回合約本體與衍生鏈鄰居（前身／後繼），關聯合約分頁不必再發一次請求
export async function GET(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const contract = getContract(Number(id));
  if (!contract) return Response.json({ error: '合約不存在' }, { status: 404 });
  return Response.json({ data: contract, relations: getContractRelations(contract) });
}

export async function PUT(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const contract = getContract(Number(id));
  if (!contract) return Response.json({ error: '合約不存在' }, { status: 404 });
  if (contract.status !== 'draft') {
    return Response.json({ error: '僅草稿可編輯；已送簽的合約請先撤回' }, { status: 409 });
  }

  const body = await request.json();
  const fields = { ...contract.fields, ...(body.fields ?? {}) };
  const signatureFields = body.signature_fields ?? contract.signature_fields;
  getDb()
    .prepare(
      "UPDATE contracts SET fields=?, signature_fields=?, updated_at=datetime('now','localtime') WHERE id=?"
    )
    .run(JSON.stringify(fields), JSON.stringify(signatureFields), contract.id);
  return Response.json({ data: { id: contract.id } });
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const contract = getContract(Number(id));
  if (!contract) return Response.json({ error: '合約不存在' }, { status: 404 });
  if (contract.status !== 'draft') {
    return Response.json({ error: '僅草稿可刪除' }, { status: 409 });
  }
  // 歷程隨合約保存，草稿刪除時一併移除
  deleteContractWithEvents(contract.id);
  return Response.json({ data: { id: contract.id } });
}
