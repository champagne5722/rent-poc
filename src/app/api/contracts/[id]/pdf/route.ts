import { NextRequest } from 'next/server';
import { getContract } from '@/lib/db';
import { contractPdfRenderer } from '@/lib/contract-pdf';
import { getPracticeRegistry } from '@/lib/practice-registry';
import { getMandateItems } from '@/lib/mandate-schedule/repository';
import { getAssignments } from '@/lib/practitioner-assignment/repository';
import { loadPrintedPractitioners } from '@/lib/practitioner-assignment/service';
import { loadContractRoutingFacts } from '@/lib/signature-routing/repository';
import { statusAnnexOf } from '@/lib/status-annex';

type Ctx = { params: Promise<{ id: string }> };

// 以目前欄位值即時產出合約 PDF（預覽與簽署區域編輯器共用）
export async function GET(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const contract = getContract(Number(id));
  if (!contract) return Response.json({ error: '合約不存在' }, { status: 404 });

  const renderer = contractPdfRenderer(contract.contract_type);
  if (!renderer) return Response.json({ error: '這個合約類型尚未支援預覽' }, { status: 400 });

  // 簽署欄印已指派的執業人員（姓名、法定稱謂、執業主體）。分流條件有問題或尚未指派時留底線
  const routing = await loadContractRoutingFacts(contract.id);
  const printed = routing.ok
    ? await loadPrintedPractitioners(routing.facts, await getAssignments(contract.id), getPracticeRegistry())
    : {};
  // 現況確認附件：草稿依分流條件印，送簽後只印凍結的內容（舊的包租合約沒有內容就不印）
  const statusAnnex = statusAnnexOf(contract.status, contract.contract_type, contract.fields);
  const pdf = await renderer.render(contract.fields, printed, { mandateItems: await getMandateItems(contract.id), statusAnnex });
  return new Response(Buffer.from(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="contract-${contract.id}.pdf"`,
      'Cache-Control': 'no-store',
    },
  });
}
