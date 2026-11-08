import { NextRequest } from 'next/server';
import { copyContractAsDraft } from '@/lib/contracts';
import { contractIdOf, contractNotFound, type ContractRouteCtx } from '@/lib/contracts/route';
import { jsonOk } from '@/lib/http';
import { inOrgTx } from '@/lib/org-route';

// 複製為新草稿：撤回／拒簽後重走流程的入口。
// 新約記「建立」、來源記「被複製為新草稿」，兩筆歷程、新約與稽核事件同交易寫入。
export async function POST(_request: NextRequest, { params }: ContractRouteCtx) {
  const id = await contractIdOf(params);
  if (!id) return contractNotFound();
  return inOrgTx(async (tx) => {
    const newId = await copyContractAsDraft(tx, id);
    return newId ? jsonOk({ data: { id: newId } }, { status: 201 }) : contractNotFound();
  });
}
