import { NextRequest } from 'next/server';
import { deleteContractWithEvents, getContract, getContractRelations, getDb } from '@/lib/db';
import { contractSubject, signing } from '@/lib/signing-module';
import { jsonOk, jsonError } from '@/lib/http';

type Ctx = { params: Promise<{ id: string }> };

// 詳情頁一次取回合約本體、衍生鏈鄰居（前身／後繼）與簽署進度，關聯合約分頁不必再發一次請求。
// 簽署進度是 null 代表沒有簽署任務：草稿，或沒有回填的舊合約。
export async function GET(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const contract = getContract(Number(id));
  if (!contract) return jsonError(404, '合約不存在');
  return jsonOk({
    data: contract,
    relations: getContractRelations(contract),
    signing_progress: await signing.getProgress(contractSubject(contract.id)),
  });
}

export async function PUT(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const contract = getContract(Number(id));
  if (!contract) return jsonError(404, '合約不存在');
  if (contract.status !== 'draft') {
    return jsonError(409, '僅草稿可編輯；已送簽的合約請先撤回');
  }

  const body = await request.json();
  const fields = { ...contract.fields, ...(body.fields ?? {}) };
  const signatureFields = body.signature_fields ?? contract.signature_fields;
  getDb()
    .prepare(
      "UPDATE contracts SET fields=?, signature_fields=?, updated_at=datetime('now','localtime') WHERE id=?"
    )
    .run(JSON.stringify(fields), JSON.stringify(signatureFields), contract.id);
  return jsonOk({ data: { id: contract.id } });
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const contract = getContract(Number(id));
  if (!contract) return jsonError(404, '合約不存在');
  if (contract.status !== 'draft') {
    return jsonError(409, '僅草稿可刪除');
  }
  // 歷程隨合約保存，草稿刪除時一併移除
  deleteContractWithEvents(contract.id);
  return jsonOk({ data: { id: contract.id } });
}
