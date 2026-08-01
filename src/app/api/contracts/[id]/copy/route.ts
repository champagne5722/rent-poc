import { NextRequest } from 'next/server';
import { getContract, getDb } from '@/lib/db';

type Ctx = { params: Promise<{ id: string }> };

// 複製為新草稿：撤回／拒簽後重走流程的入口
export async function POST(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const contract = getContract(Number(id));
  if (!contract) return Response.json({ error: '合約不存在' }, { status: 404 });

  const result = getDb()
    .prepare('INSERT INTO contracts (property_id, fields, signature_fields) VALUES (?, ?, ?)')
    .run(contract.property_id, JSON.stringify(contract.fields), JSON.stringify(contract.signature_fields));
  return Response.json({ data: { id: Number(result.lastInsertRowid) } }, { status: 201 });
}
