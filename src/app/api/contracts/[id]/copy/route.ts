import { NextRequest } from 'next/server';
import { copyContractAsDraft, getContract } from '@/lib/db';
import { jsonOk, jsonError } from '@/lib/http';

type Ctx = { params: Promise<{ id: string }> };

// 複製為新草稿：撤回／拒簽後重走流程的入口。
// 新約記「建立」、來源記「被複製為新草稿」，兩筆歷程與新約同交易寫入。
export async function POST(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const contract = getContract(Number(id));
  if (!contract) return jsonError(404, '合約不存在');

  const newId = copyContractAsDraft(contract);
  return jsonOk({ data: { id: newId } }, { status: 201 });
}
