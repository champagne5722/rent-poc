import { NextRequest } from 'next/server';
import { getContract } from '@/lib/contracts';
import { contractIdOf, contractNotFound, type ContractRouteCtx } from '@/lib/contracts/route';
import { readInOrgTx } from '@/lib/org-route';
import { generateContractPdf, PDF_PAGE_SIZE } from '@/lib/pdf';
import { getPracticeRegistry } from '@/lib/practice-registry';
import { loadSendInputs, prepareContractSend, recordSendSnapshots } from '@/lib/practitioner-assignment/send';
import { contractDocumentFileName } from '@/lib/signing';
import { contractSubject, signing, signingErrorResponse } from '@/lib/signing-module';
import { jsonOk, jsonError } from '@/lib/http';

// 送簽：驗證欄位 → 產出 PDF → 交給簽署模組（建立簽署任務，合約進入「待乙方簽」）
export async function POST(_request: NextRequest, { params }: ContractRouteCtx) {
  const id = await contractIdOf(params);
  if (!id) return contractNotFound();
  // 合約與分流條件在同一個交易讀。產 PDF 與呼叫簽署服務商都在交易外
  const read = await readInOrgTx(async (tx) => {
    const found = await getContract(tx, id);
    return found ? { contract: found, inputs: await loadSendInputs(tx, id) } : null;
  });
  if (!read.ok) return read.response;
  if (!read.value) return contractNotFound();
  const { contract, inputs } = read.value;
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
  // 送簽前檢查（ADR-0018 決議 10）：分流、執業人員指派與資格。不符時列出全部原因，簽署人與判定事實快照通過才產生
  const prepared = await prepareContractSend(contract, inputs, getPracticeRegistry(), new Date().toISOString());
  if (!prepared.ok) {
    return jsonOk({ error: prepared.error, reasons: prepared.reasons }, { status: prepared.status });
  }

  const pdf = await generateContractPdf(f, prepared.printed);
  try {
    const task = await signing.send(
      contractSubject(contract.id),
      { fileName: contractDocumentFileName(contract), pdf, pageSize: PDF_PAGE_SIZE },
      prepared.signers,
      // 判定事實快照與簽署任務、合約狀態同一個交易：建立簽署任務失敗時不留快照
      { alsoInTx: (tx) => recordSendSnapshots(tx, contract.id, prepared) }
    );
    // 簽署模組不對外提供服務商任務編號（ADR-0010），回應不帶 task_id
    return jsonOk({ data: { id: contract.id, mock: task.mode === 'mock', notices: prepared.notices } });
  } catch (e) {
    return signingErrorResponse(e, '送簽失敗');
  }
}
