import { NextRequest } from 'next/server';
import { copyContractAsDraft, getContract } from '@/lib/db';
import { copyMandateItems } from '@/lib/mandate-schedule/repository';
import { copyAssignments } from '@/lib/practitioner-assignment/repository';

type Ctx = { params: Promise<{ id: string }> };

// 複製為新草稿：撤回／拒簽後重走流程的入口。
// 新約記「建立」、來源記「被複製為新草稿」，兩筆歷程與新約同交易寫入。
export async function POST(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const contract = getContract(Number(id));
  if (!contract) return Response.json({ error: '合約不存在' }, { status: 404 });

  const newId = copyContractAsDraft(contract);
  // 沿用執業人員的指派。改派一律是撤回後衍生新草稿（ADR-0018 決議 11），新草稿仍要重新通過送簽前檢查
  await copyAssignments(contract.id, newId);
  // 委託標的清單（委託管理合約）也沿用。租賃合約沒有清單，複製是空操作
  await copyMandateItems(contract.id, newId);
  return Response.json({ data: { id: newId } }, { status: 201 });
}
