import { NextRequest } from 'next/server';
import { getContract, getDb } from '@/lib/db';
import { contractPdfRenderer } from '@/lib/contract-pdf';
import { contractTypeDefinition, missingFieldsForSendOf } from '@/lib/contract-types';
import { getPracticeRegistry } from '@/lib/practice-registry';
import { prepareContractSend } from '@/lib/practitioner-assignment/send';
import { contractDocumentFileName } from '@/lib/signing';
import { contractSubject, signing, signingErrorResponse } from '@/lib/signing-module';
import { statusAnnexOf } from '@/lib/status-annex';
import { statusAnnexPageMap } from '@/lib/status-annex/server';

type Ctx = { params: Promise<{ id: string }> };

// 送簽：驗證欄位 → 產出 PDF → 交給簽署模組（建立簽署任務，合約進入「待乙方簽」）
export async function POST(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const contract = getContract(Number(id));
  if (!contract) return Response.json({ error: '合約不存在' }, { status: 404 });
  if (contract.status !== 'draft') {
    return Response.json({ error: '僅草稿可送簽' }, { status: 409 });
  }

  // PDF 與必填欄位都依合約類型。委託管理合約有草稿與 PDF 預覽，送簽屬 MIL-77，在那之前不能送簽。
  const renderer = contractPdfRenderer(contract.contract_type);
  if (!renderer || !contractTypeDefinition(contract.contract_type).sendSupported) {
    return Response.json({ error: '這個合約類型尚未支援送簽' }, { status: 400 });
  }
  const missing = missingFieldsForSendOf(contract);
  if (missing.length) {
    return Response.json({ error: `請先完成欄位：${missing.join('、')}` }, { status: 400 });
  }
  // 簽署序列由簽章分流規則表產生（ADR-0018）
  // 送簽前檢查（ADR-0018 決議 10）：分流、執業人員指派與資格。不符時列出全部原因，簽署人與簽章紀錄資料通過才產生
  // 現況確認附件頁要有執業人員的簽署區域（MIL-71）：附件頁的頁碼由 PDF 版面算出，缺少時併入原因清單
  const pages = await statusAnnexPageMap(contract);
  const prepared = await prepareContractSend(contract, getPracticeRegistry(), new Date().toISOString(), getDb(), { pages });
  if (!prepared.ok) {
    return Response.json({ error: prepared.error, reasons: prepared.reasons }, { status: prepared.status });
  }

  const statusAnnex = statusAnnexOf(contract.status, contract.contract_type, contract.fields);
  const pdf = await renderer.render(contract.fields, prepared.printed, { statusAnnex });
  try {
    const task = await signing.send(
      contractSubject(contract.id),
      { fileName: contractDocumentFileName(contract), pdf, pageSize: renderer.pageSize },
      prepared.signers,
      // 簽章紀錄在送簽交易內寫入（MIL-70），送簽失敗時不留紀錄
      prepared.sendContext
    );
    // 簽署模組不對外提供服務商任務編號（ADR-0010），回應不帶 task_id
    return Response.json({ data: { id: contract.id, mock: task.mode === 'mock', notices: prepared.notices } });
  } catch (e) {
    return signingErrorResponse(e, '送簽失敗');
  }
}
