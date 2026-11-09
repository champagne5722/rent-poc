import { NextRequest } from 'next/server';
import { getContract, listContractEvents } from '@/lib/contracts';
import { contractIdOf, contractNotFound, type ContractRouteCtx } from '@/lib/contracts/route';
import { jsonOk } from '@/lib/http';
import { inOrgTx } from '@/lib/org-route';

// 合約歷程：append-only 里程碑事件序列，依發生順序回傳（詳情頁「歷程」分頁用）。
// 刻意只有 GET——事件沒有編輯／刪除入口（ADR-0007）。
export async function GET(_request: NextRequest, { params }: ContractRouteCtx) {
  const id = await contractIdOf(params);
  if (!id) return contractNotFound();
  return inOrgTx(async (tx) => {
    if (!(await getContract(tx, id))) return contractNotFound();
    return jsonOk({ data: await listContractEvents(tx, id) });
  });
}
