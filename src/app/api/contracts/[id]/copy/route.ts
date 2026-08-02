import { NextRequest } from 'next/server';
import { copyContractAsDraft, getContract } from '@/lib/db';

type Ctx = { params: Promise<{ id: string }> };

// 複製為新草稿：撤回／拒簽後重走流程的入口。
// 新約記「建立」、來源記「被複製為新草稿」，兩筆歷程與新約同交易寫入。
export async function POST(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const contract = getContract(Number(id));
  if (!contract) return Response.json({ error: '合約不存在' }, { status: 404 });

  const newId = copyContractAsDraft(contract);
  return Response.json({ data: { id: newId } }, { status: 201 });
}
