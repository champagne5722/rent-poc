import { NextRequest } from 'next/server';
import { getContract } from '@/lib/db';
import { getSignedPdfDownloadLink, isMockMode } from '@/lib/dottedsign';
import { generateContractPdf } from '@/lib/pdf';

type Ctx = { params: Promise<{ id: string }> };

// 下載已簽 PDF：live 模式轉向點點簽的下載連結；mock 模式回未簽版充當示意
export async function GET(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const contract = getContract(Number(id));
  if (!contract) return Response.json({ error: '合約不存在' }, { status: 404 });
  if (contract.status !== 'completed') {
    return Response.json({ error: '合約尚未完成簽署' }, { status: 409 });
  }

  if (isMockMode()) {
    const pdf = await generateContractPdf(contract.fields);
    return new Response(Buffer.from(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="signed-contract-${contract.id}-mock.pdf"`,
      },
    });
  }

  try {
    const url = await getSignedPdfDownloadLink(contract.dottedsign_task_id!);
    if (!url) return Response.json({ error: '點點簽未回傳下載連結' }, { status: 502 });
    return Response.redirect(url, 302);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : '取得下載連結失敗' }, { status: 502 });
  }
}
