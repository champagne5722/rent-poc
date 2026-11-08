import { NextRequest } from 'next/server';
import { getContract } from '@/lib/contracts';
import { contractIdOf, contractNotFound, type ContractRouteCtx } from '@/lib/contracts/route';
import { readInOrgTx } from '@/lib/org-route';
import { generateContractPdf } from '@/lib/pdf';
import { getPracticeRegistry } from '@/lib/practice-registry';
import { getAssignments } from '@/lib/practitioner-assignment/repository';
import { loadPrintedPractitioners } from '@/lib/practitioner-assignment/service';
import { loadContractRoutingFacts } from '@/lib/signature-routing/repository';

// 以目前欄位值即時產出合約 PDF（預覽與簽署區域編輯器共用）
export async function GET(_request: NextRequest, { params }: ContractRouteCtx) {
  const id = await contractIdOf(params);
  if (!id) return contractNotFound();
  // 產 PDF 是 CPU 密集的工作，放在交易外，不佔著連線
  const read = await readInOrgTx(async (tx) => {
    const found = await getContract(tx, id);
    if (!found) return null;
    return { contract: found, routing: await loadContractRoutingFacts(tx, id), assignments: await getAssignments(tx, id) };
  });
  if (!read.ok) return read.response;
  if (!read.value) return contractNotFound();
  const { contract, routing, assignments } = read.value;

  // 簽署欄印已指派的執業人員（姓名、法定稱謂、執業主體）。分流條件有問題或尚未指派時留底線
  const printed = routing.ok ? await loadPrintedPractitioners(routing.facts, assignments, getPracticeRegistry()) : {};
  const pdf = await generateContractPdf(contract.fields, printed);
  return new Response(Buffer.from(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="contract-${contract.id}.pdf"`,
      'Cache-Control': 'no-store',
    },
  });
}
