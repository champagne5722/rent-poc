import { NextRequest } from 'next/server';
import { contractIdOf, contractNotFound, type ContractRouteCtx } from '@/lib/contracts/route';
import { contractSubject, signing, signingErrorResponse } from '@/lib/signing-module';
import { jsonOk } from '@/lib/http';

// 甲方撤回簽署中的合約（PoC 的「修約」機制：撤回 → 複製為新草稿重送）
export async function POST(_request: NextRequest, { params }: ContractRouteCtx) {
  const id = await contractIdOf(params);
  if (!id) return contractNotFound();
  try {
    await signing.voidTask(contractSubject(id));
    return jsonOk({ data: { id } });
  } catch (e) {
    return signingErrorResponse(e, '撤回失敗');
  }
}
