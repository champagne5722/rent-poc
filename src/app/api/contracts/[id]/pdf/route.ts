import { NextRequest } from 'next/server';
import { getContract } from '@/lib/contracts';
import { contractIdOf, contractNotFound, type ContractRouteCtx } from '@/lib/contracts/route';
import { readInOrgTx } from '@/lib/org-route';
import { generateContractPdf } from '@/lib/pdf';

// 以目前欄位值即時產出合約 PDF（預覽與簽署區域編輯器共用）
export async function GET(_request: NextRequest, { params }: ContractRouteCtx) {
  const id = await contractIdOf(params);
  if (!id) return contractNotFound();
  // 產 PDF 是 CPU 密集的工作，放在交易外，不佔著連線
  const read = await readInOrgTx((tx) => getContract(tx, id));
  if (!read.ok) return read.response;
  const contract = read.value;
  if (!contract) return contractNotFound();

  const pdf = await generateContractPdf(contract.fields);
  return new Response(Buffer.from(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="contract-${contract.id}.pdf"`,
      'Cache-Control': 'no-store',
    },
  });
}
