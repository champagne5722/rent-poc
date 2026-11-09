import { getContract } from '@/lib/db';
import { listSigningLapses } from '@/lib/signing-lapse/repository';

type Ctx = { params: Promise<{ id: string }> };

// 合約的簽署中失效紀錄（MIL-75），唯讀。詳情頁用它顯示警示與撤回按鈕。沒有失效時回空陣列。
export async function GET(_request: Request, { params }: Ctx) {
  const { id } = await params;
  const contract = getContract(Number(id));
  if (!contract) return Response.json({ error: '合約不存在' }, { status: 404 });
  return Response.json({ data: await listSigningLapses(contract.id) });
}
