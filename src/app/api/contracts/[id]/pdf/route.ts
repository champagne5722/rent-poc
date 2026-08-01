import { NextRequest } from 'next/server';
import { getContract } from '@/lib/db';
import { generateContractPdf } from '@/lib/pdf';

type Ctx = { params: Promise<{ id: string }> };

// 以目前欄位值即時產出合約 PDF（預覽與簽署區域編輯器共用）
export async function GET(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const contract = getContract(Number(id));
  if (!contract) return Response.json({ error: '合約不存在' }, { status: 404 });

  const pdf = await generateContractPdf(contract.fields);
  return new Response(Buffer.from(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="contract-${contract.id}.pdf"`,
      'Cache-Control': 'no-store',
    },
  });
}
