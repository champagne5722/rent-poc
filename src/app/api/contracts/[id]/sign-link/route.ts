import { NextRequest } from 'next/server';
import { getContract } from '@/lib/db';
import { getSignerShareLink, isMockMode } from '@/lib/dottedsign';
import { currentSigner } from '@/lib/signing';

type Ctx = { params: Promise<{ id: string }> };

// 簽署連結現查（見 CONTEXT.md「簽署連結」）：email 沒收到時的備案。
// 依合約狀態決定當前待簽方，向點點簽要該簽署人的連結，簽完導回合約頁。
export async function GET(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const contract = getContract(Number(id));
  if (!contract) return Response.json({ error: '合約不存在' }, { status: 404 });
  if (isMockMode()) return Response.json({ error: 'mock 模式無簽署連結' }, { status: 409 });

  const signer = currentSigner(contract);
  if (!signer || !contract.dottedsign_task_id) {
    return Response.json({ error: '合約不在簽署中，沒有待簽方' }, { status: 409 });
  }

  const redirectUrl = `${new URL(request.url).origin}/contracts/${contract.id}`;
  try {
    const link = await getSignerShareLink(contract.dottedsign_task_id, signer.email, redirectUrl);
    return Response.json({
      data: { role: signer.role, name: signer.name, email: signer.email, sign_link: link },
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : '取得簽署連結失敗' }, { status: 502 });
  }
}
