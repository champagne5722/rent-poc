import { NextRequest } from 'next/server';
import { authorizeIgnoringState } from '@/lib/authorize';
import { getContract } from '@/lib/contracts';
import { contractIdOf, contractNotFound, type ContractRouteCtx } from '@/lib/contracts/route';
import { contractPdfRenderer } from '@/lib/contract-pdf';
import { missingFieldsForSendOf } from '@/lib/contract-types';
import { readInOrgTx } from '@/lib/org-route';
import { getPracticeRegistry } from '@/lib/practice-registry';
import { loadSendInputs, prepareContractSend } from '@/lib/practitioner-assignment/send';
import { contractDocumentFileName } from '@/lib/signing';
import { contractSubject, signing, signingErrorResponse } from '@/lib/signing-module';
import { jsonOk, jsonError } from '@/lib/http';

// 送簽：驗證欄位 → 產出 PDF → 交給簽署模組（建立簽署任務，合約進入「待乙方簽」）
export async function POST(_request: NextRequest, { params }: ContractRouteCtx) {
  const id = await contractIdOf(params);
  if (!id) return contractNotFound();
  // 合約與分流條件在同一個交易讀。產 PDF 與呼叫簽署服務商都在交易外
  const read = await readInOrgTx(async (tx) => {
    await authorizeIgnoringState(tx, 'contract.draft_send', { type: 'contract', id });
    const found = await getContract(tx, id);
    return found ? { contract: found, inputs: await loadSendInputs(tx, id) } : null;
  });
  if (!read.ok) return read.response;
  if (!read.value) return contractNotFound();
  const { contract, inputs } = read.value;
  if (contract.status !== 'draft') {
    return jsonError(409, '僅草稿可送簽');
  }

  // PDF 與必填欄位都依合約類型。沒有 PDF 的類型（委託管理合約屬 MIL-74、MIL-77）尚未支援送簽。
  const renderer = contractPdfRenderer(contract.contract_type);
  if (!renderer) {
    return jsonError(400, '這個合約類型尚未支援送簽');
  }
  const missing = missingFieldsForSendOf(contract);
  if (missing.length) {
    return jsonError(400, `請先完成欄位：${missing.join('、')}`);
  }
  // 簽署序列由簽章分流規則表產生（ADR-0018）
  // 送簽前檢查（ADR-0018 決議 10）：分流、執業人員指派與資格。不符時列出全部原因，簽署人與簽章紀錄資料通過才產生
  const prepared = await prepareContractSend(contract, inputs, getPracticeRegistry(), new Date().toISOString());
  if (!prepared.ok) {
    return jsonOk({ error: prepared.error, reasons: prepared.reasons }, { status: prepared.status });
  }

  const pdf = await renderer.render(contract.fields, prepared.printed);
  try {
    const task = await signing.send(
      contractSubject(contract.id),
      { fileName: contractDocumentFileName(contract), pdf, pageSize: renderer.pageSize },
      prepared.signers,
      // 簽章紀錄在送簽交易內寫入（MIL-70），送簽失敗時不留紀錄
      { context: prepared.sendContext }
    );
    // 簽署模組不對外提供服務商任務編號（ADR-0010），回應不帶 task_id
    return jsonOk({ data: { id: contract.id, mock: task.mode === 'mock', notices: prepared.notices } });
  } catch (e) {
    return signingErrorResponse(e, '送簽失敗');
  }
}
