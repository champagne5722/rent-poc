import { NextRequest } from 'next/server';
import { getContract } from '@/lib/db';
import { isMockMode, resendSignTask } from '@/lib/dottedsign';
import { currentSigner } from '@/lib/signing';

type Ctx = { params: Promise<{ id: string }> };

// 重寄簽署通知信給當前待簽方（email 沒收到時的第一線備案）
export async function POST(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const contract = getContract(Number(id));
  if (!contract) return Response.json({ error: '合約不存在' }, { status: 404 });
  if (isMockMode()) return Response.json({ error: 'mock 模式不寄信' }, { status: 409 });

  const signer = currentSigner(contract);
  if (!signer || !contract.dottedsign_task_id) {
    return Response.json({ error: '合約不在簽署中，沒有待簽方' }, { status: 409 });
  }

  try {
    await resendSignTask(contract.dottedsign_task_id);
    return Response.json({ data: { resent_to: signer.email } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : '重寄通知失敗';
    // sandbox 一律回 403036（access_info.resend=false，見整合筆記），轉成看得懂的說明
    if (msg.includes('task_not_accessible')) {
      return Response.json(
        { error: '點點簽拒絕重寄：sandbox 不提供 resend，正式環境才能驗證' },
        { status: 502 }
      );
    }
    return Response.json({ error: msg }, { status: 502 });
  }
}
