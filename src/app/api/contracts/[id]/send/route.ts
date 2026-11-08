import { NextRequest } from 'next/server';
import { getContract } from '@/lib/db';
import { generateContractPdf, PDF_PAGE_SIZE } from '@/lib/pdf';
import { getPracticeRegistry } from '@/lib/practice-registry';
import { prepareContractSend } from '@/lib/practitioner-assignment/send';
import { contractDocumentFileName } from '@/lib/signing';
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
  // 簽署序列由簽章分流規則表產生（ADR-0018）。PDF 與欄位檢查目前只支援租賃合約，委託管理合約屬 MIL-74、MIL-77。
  if (contract.contract_type !== 'lease') {
    return Response.json({ error: '這個合約類型尚未支援送簽' }, { status: 400 });
  }
  // 送簽前檢查（ADR-0018 決議 10）：分流、執業人員指派與資格。不符時列出全部原因，簽署人與簽章紀錄資料通過才產生
  const prepared = await prepareContractSend(contract, getPracticeRegistry(), new Date().toISOString());
  if (!prepared.ok) {
    return Response.json({ error: prepared.error, reasons: prepared.reasons }, { status: prepared.status });
  }

  const pdf = await generateContractPdf(f, prepared.printed);
  try {
    const task = await signing.send(
      contractSubject(contract.id),
      { fileName: contractDocumentFileName(contract), pdf, pageSize: PDF_PAGE_SIZE },
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
