import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { attachContract } from '@/lib/case-store';
import { copyContractAsDraft, getContract, getContractCaseId } from '@/lib/contracts';
import { contractIdOf, contractNotFound, type ContractRouteCtx } from '@/lib/contracts/route';
import { jsonOk } from '@/lib/http';
import { inOrgTxAs } from '@/lib/org-route';
import { copyAssignments } from '@/lib/practitioner-assignment/repository';

// 複製為新草稿：撤回／拒簽後重走流程的入口。
// 新約記「建立」、來源記「被複製為新草稿」，兩筆歷程、新約與稽核事件同交易寫入。
export async function POST(_request: NextRequest, { params }: ContractRouteCtx) {
  const id = await contractIdOf(params);
  if (!id) return contractNotFound();
  return inOrgTxAs(async (tx, rc) => {
    await authorize(tx, 'contract.copy', { type: 'contract', id });
    const newId = await copyContractAsDraft(tx, id);
    // 沿用執業人員的指派。改派一律是撤回後衍生新草稿（ADR-0018 決議 11），新草稿仍要重新通過送簽前檢查
    if (newId) await copyAssignments(tx, id, newId);
    // 新草稿留在同一案件，案件的目前合約改指向它（P0-09 AC7、ADR-0016 決議 12）
    if (newId) {
      const caseId = await getContractCaseId(tx, id);
      if (caseId) {
        const derivedFrom = (await getContract(tx, newId))?.derived_from ?? null;
        await attachContract(tx, caseId, newId, { actor: { partyId: rc.partyId }, derivedFrom });
      }
    }
    return newId ? jsonOk({ data: { id: newId } }, { status: 201 }) : contractNotFound();
  });
}
