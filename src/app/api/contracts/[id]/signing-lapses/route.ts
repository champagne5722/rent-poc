import { NextRequest } from 'next/server';
import { getContract } from '@/lib/contracts';
import { contractIdOf, contractNotFound, type ContractRouteCtx } from '@/lib/contracts/route';
import { jsonOk } from '@/lib/http';
import { inOrgTx } from '@/lib/org-route';
import { listSigningLapses } from '@/lib/signing-lapse/repository';

// 合約的簽署中失效紀錄（MIL-75），唯讀。詳情頁用它顯示警示與撤回按鈕。沒有失效時回空陣列。
export async function GET(_request: NextRequest, { params }: ContractRouteCtx) {
  const id = await contractIdOf(params);
  if (!id) return contractNotFound();
  return inOrgTx(async (tx) => {
    if (!(await getContract(tx, id))) return contractNotFound();
    return jsonOk({ data: await listSigningLapses(tx, id) });
  });
}
