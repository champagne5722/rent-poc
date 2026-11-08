import { NextRequest } from 'next/server';
import { getContract } from '@/lib/db';
import { generateContractPdf, PDF_PAGE_SIZE } from '@/lib/pdf';
import { contractDocumentFileName, contractSignerSequence } from '@/lib/signing';
import { contractSubject, signing, signingErrorResponse } from '@/lib/signing-module';
import { jsonOk, jsonError } from '@/lib/http';

type Ctx = { params: Promise<{ id: string }> };

// 送簽：驗證欄位 → 產出 PDF → 交給簽署模組（建立簽署任務，合約進入「待乙方簽」）
export async function POST(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const contract = getContract(Number(id));
  if (!contract) return jsonError(404, '合約不存在');
  if (contract.status !== 'draft') {
    return jsonError(409, '僅草稿可送簽');
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
    return jsonError(400, `請先完成欄位：${missing.join('、')}`);
  }
  if (!contract.signature_fields.some((s) => s.signer === 'party_b')) {
    return jsonError(400, '請至少為乙方設定一個簽署區域');
  }
  if (!contract.signature_fields.some((s) => s.signer === 'party_a')) {
    return jsonError(400, '請至少為甲方設定一個簽署區域');
  }

  const pdf = await generateContractPdf(f);
  try {
    const task = await signing.send(
      contractSubject(contract.id),
      { fileName: contractDocumentFileName(contract), pdf, pageSize: PDF_PAGE_SIZE },
      contractSignerSequence(contract)
    );
    // 簽署模組不對外提供服務商任務編號（ADR-0010），回應不帶 task_id
    return jsonOk({ data: { id: contract.id, mock: task.mode === 'mock' } });
  } catch (e) {
    return signingErrorResponse(e, '送簽失敗');
  }
}
