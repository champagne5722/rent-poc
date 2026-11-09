import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { copyContractAsDraft } from '@/lib/contracts';
import { contractIdOf, contractNotFound, type ContractRouteCtx } from '@/lib/contracts/route';
import { jsonOk } from '@/lib/http';
import { inOrgTx } from '@/lib/org-route';
import { copyAssignments } from '@/lib/practitioner-assignment/repository';

// 複製為新草稿：撤回／拒簽後重走流程的入口。
// 新約記「建立」、來源記「被複製為新草稿」，兩筆歷程、新約與稽核事件同交易寫入。
export async function POST(_request: NextRequest, { params }: ContractRouteCtx) {
  const id = await contractIdOf(params);
  if (!id) return contractNotFound();
  return inOrgTx(async (tx) => {
    await authorize(tx, 'contract.copy', { type: 'contract', id });
    const newId = await copyContractAsDraft(tx, id);
    // 沿用執業人員的指派。改派一律是撤回後衍生新草稿（ADR-0018 決議 11），新草稿仍要重新通過送簽前檢查
    if (newId) await copyAssignments(tx, id, newId);
    return newId ? jsonOk({ data: { id: newId } }, { status: 201 }) : contractNotFound();
  });
}
