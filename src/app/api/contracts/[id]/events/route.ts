import { NextRequest } from 'next/server';
import { getContract, listContractEvents } from '@/lib/db';

type Ctx = { params: Promise<{ id: string }> };

// 合約歷程：append-only 里程碑事件序列，依發生順序回傳（詳情頁「歷程」分頁用）。
// 刻意只有 GET——事件沒有編輯／刪除入口（ADR-0007）。
export async function GET(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const contract = getContract(Number(id));
  if (!contract) return Response.json({ error: '合約不存在' }, { status: 404 });

  return Response.json({ data: listContractEvents(contract.id) });
}
