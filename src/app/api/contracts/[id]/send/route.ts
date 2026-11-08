import { NextRequest } from 'next/server';
import { getContract } from '@/lib/contracts';
import { contractIdOf, contractNotFound, type ContractRouteCtx } from '@/lib/contracts/route';
import { readInOrgTx } from '@/lib/org-route';
import { generateContractPdf, PDF_PAGE_SIZE } from '@/lib/pdf';
import { loadContractRoutingFacts } from '@/lib/signature-routing/repository';
import { contractDocumentFileName, prepareContractSigners } from '@/lib/signing';
import { contractSubject, signing, signingErrorResponse } from '@/lib/signing-module';
import { jsonOk, jsonError } from '@/lib/http';

// 送簽：驗證欄位 → 產出 PDF → 交給簽署模組（建立簽署任務，合約進入「待乙方簽」）
export async function POST(_request: NextRequest, { params }: ContractRouteCtx) {
  const id = await contractIdOf(params);
  if (!id) return contractNotFound();
  // 合約與分流條件在同一個交易讀。產 PDF 與呼叫簽署服務商都在交易外
  const read = await readInOrgTx(async (tx) => {
    const found = await getContract(tx, id);
    return found ? { contract: found, routing: await loadContractRoutingFacts(tx, id) } : null;
  });
  if (!read.ok) return read.response;
  if (!read.value) return contractNotFound();
  const { contract, routing } = read.value;
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
