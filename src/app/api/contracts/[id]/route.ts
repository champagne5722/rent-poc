import { NextRequest } from 'next/server';
import { deleteContractWithEvents, getContract, getContractRelations, getDb } from '@/lib/db';
import { contractSubject, signing } from '@/lib/signing-module';
import { routingInputError } from '@/lib/signature-routing';
import { statusAnnexInputError } from '@/lib/status-annex';

type Ctx = { params: Promise<{ id: string }> };

// 詳情頁一次取回合約本體、衍生鏈鄰居（前身／後繼）與簽署進度，關聯合約分頁不必再發一次請求。
// 簽署進度是 null 代表沒有簽署任務：草稿，或沒有回填的舊合約。
export async function GET(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const contract = getContract(Number(id));
  if (!contract) return Response.json({ error: '合約不存在' }, { status: 404 });
  return Response.json({
    data: contract,
    relations: getContractRelations(contract),
    signing_progress: await signing.getProgress(contractSubject(contract.id)),
  });
}

export async function PUT(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const contract = getContract(Number(id));
  if (!contract) return Response.json({ error: '合約不存在' }, { status: 404 });
  if (contract.status !== 'draft') {
    return Response.json({ error: '僅草稿可編輯；已送簽的合約請先撤回' }, { status: 409 });
  }

  const body = await request.json();
  const routingError = routingInputError(body.fields?.routing, contract.contract_type);
  if (routingError) return Response.json({ error: routingError }, { status: 400 });
  // 現況確認附件隨草稿保存（MIL-71）。只檢查形狀，填沒填完由送簽前的必填檢核擋
  const annexError = statusAnnexInputError(body.fields?.statusAnnex);
  if (annexError) return Response.json({ error: annexError }, { status: 400 });
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
