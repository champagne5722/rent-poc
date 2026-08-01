import { NextRequest } from 'next/server';
import { getContract } from '@/lib/db';
import { voidSignTask } from '@/lib/dottedsign';
import { applyDsEvent } from '@/lib/transitions';

type Ctx = { params: Promise<{ id: string }> };

// 甲方撤回簽署中的合約（PoC 的「修約」機制：撤回 → 複製為新草稿重送）
export async function POST(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const contract = getContract(Number(id));
  if (!contract) return Response.json({ error: '合約不存在' }, { status: 404 });
  if (contract.status !== 'awaiting_tenant' && contract.status !== 'awaiting_landlord') {
    return Response.json({ error: '僅簽署中的合約可撤回' }, { status: 409 });
  }

  try {
    if (contract.dottedsign_task_id) await voidSignTask(contract.dottedsign_task_id);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : '撤回失敗' }, { status: 502 });
  }
  applyDsEvent(contract, 'voided');
  return Response.json({ data: { id: contract.id } });
}
