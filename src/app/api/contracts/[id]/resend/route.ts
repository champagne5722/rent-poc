import { NextRequest } from 'next/server';
import { contractIdOf, contractNotFound, type ContractRouteCtx } from '@/lib/contracts/route';
import { contractSubject, signing, signingErrorResponse } from '@/lib/signing-module';
import { jsonOk } from '@/lib/http';
import { authorizeOnly } from '@/lib/org-route';

// 重寄簽署通知信給當前待簽方（email 沒收到時的第一線備案）
export async function POST(_request: NextRequest, { params }: ContractRouteCtx) {
  const id = await contractIdOf(params);
  if (!id) return contractNotFound();
  const denied = await authorizeOnly('contract.resend', { type: 'contract', id }, { ignoreCaseState: true });
  if (denied) return denied;
  try {
    const { signer } = await signing.resend(contractSubject(id));
    return jsonOk({ data: { resent_to: signer.email } });
  } catch (e) {
    return signingErrorResponse(e, '重寄通知失敗');
  }
}
