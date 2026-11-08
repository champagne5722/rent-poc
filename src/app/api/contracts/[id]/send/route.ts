import { NextRequest } from 'next/server';
import { getContract } from '@/lib/db';
import { generateContractPdf, PDF_PAGE_SIZE } from '@/lib/pdf';
import { loadContractRoutingFacts } from '@/lib/signature-routing/repository';
import { contractDocumentFileName, prepareContractSigners } from '@/lib/signing';
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
  // 簽署序列由簽章分流規則表產生（ADR-0018）。PDF 與欄位檢查目前只支援租賃合約，委託管理合約屬 MIL-74、MIL-77。
  if (contract.contract_type !== 'lease') {
    return jsonError(400, '這個合約類型尚未支援送簽');
  }
  const routing = await loadContractRoutingFacts(contract.id);
  if (!routing.ok) return jsonError(400, routing.reason);
  const prepared = prepareContractSigners(contract, routing.facts);
  if (!prepared.ok) return jsonError(prepared.status, prepared.error);

  const pdf = await generateContractPdf(f);
  try {
    const task = await signing.send(
      contractSubject(contract.id),
      { fileName: contractDocumentFileName(contract), pdf, pageSize: PDF_PAGE_SIZE },
      prepared.signers
    );
    // 簽署模組不對外提供服務商任務編號（ADR-0010），回應不帶 task_id
    return jsonOk({ data: { id: contract.id, mock: task.mode === 'mock' } });
  } catch (e) {
    return signingErrorResponse(e, '送簽失敗');
  }
}
