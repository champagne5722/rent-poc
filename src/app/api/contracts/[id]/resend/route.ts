import { NextRequest } from 'next/server';
import { contractSubject, signing, signingErrorResponse } from '@/lib/signing-module';
import { jsonOk } from '@/lib/http';

type Ctx = { params: Promise<{ id: string }> };

// 重寄簽署通知信給當前待簽方（email 沒收到時的第一線備案）
export async function POST(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  try {
    const { signer } = await signing.resend(contractSubject(Number(id)));
    return jsonOk({ data: { resent_to: signer.email } });
  } catch (e) {
    return signingErrorResponse(e, '重寄通知失敗');
  }
}
