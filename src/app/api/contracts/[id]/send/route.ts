import { NextRequest } from 'next/server';
import { getContract } from '@/lib/db';
import { generateContractPdf, PDF_PAGE_SIZE } from '@/lib/pdf';
import { contractDocumentFileName, contractSignerSequence } from '@/lib/signing';
import { contractSubject, signing, signingErrorResponse } from '@/lib/signing-module';

type Ctx = { params: Promise<{ id: string }> };

// 送簽：驗證欄位 → 產出 PDF → 交給簽署模組（建立簽署任務，合約進入「待乙方簽」）
export async function POST(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const contract = getContract(Number(id));
  if (!contract) return Response.json({ error: '合約不存在' }, { status: 404 });
  if (contract.status !== 'draft') {
    return Response.json({ error: '僅草稿可送簽' }, { status: 409 });
  }

  const f = contract.fields;
  const missing: string[] = [];
  if (!f.landlordName.trim()) missing.push('甲方姓名');
  if (!/.+@.+\..+/.test(f.landlordEmail)) missing.push('甲方 Email');
  if (!f.tenantName.trim()) missing.push('乙方姓名');
  if (!/.+@.+\..+/.test(f.tenantEmail)) missing.push('乙方 Email');
  if (!f.startDate || !f.endDate) missing.push('租期起迄');
  if (f.rent == null) missing.push('租金');
  if (missing.length) {
    return Response.json({ error: `請先完成欄位：${missing.join('、')}` }, { status: 400 });
  }
  if (!contract.signature_fields.some((s) => s.signer === 'tenant')) {
    return Response.json({ error: '請至少為乙方設定一個簽署區域' }, { status: 400 });
  }
  if (!contract.signature_fields.some((s) => s.signer === 'landlord')) {
    return Response.json({ error: '請至少為甲方設定一個簽署區域' }, { status: 400 });
  }

  const pdf = await generateContractPdf(f);
  try {
    const task = await signing.send(
      contractSubject(contract.id),
      { fileName: contractDocumentFileName(contract), pdf, pageSize: PDF_PAGE_SIZE },
      contractSignerSequence(contract)
    );
    // task_id 是既有回應欄位，由合約欄位讀取。簽署模組不對外提供服務商任務編號。
    return Response.json({
      data: { id: contract.id, task_id: getContract(contract.id)?.dottedsign_task_id, mock: task.mode === 'mock' },
    });
  } catch (e) {
    return signingErrorResponse(e, '送簽失敗');
  }
}
