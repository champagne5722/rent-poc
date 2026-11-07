import { NextRequest } from 'next/server';
import { contractSubject, signing, signingErrorResponse } from '@/lib/signing-module';

type Ctx = { params: Promise<{ id: string }> };

// 甲方撤回簽署中的合約（PoC 的「修約」機制：撤回 → 複製為新草稿重送）
export async function POST(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const contractId = Number(id);
  try {
    await signing.voidTask(contractSubject(contractId));
    return Response.json({ data: { id: contractId } });
  } catch (e) {
    return signingErrorResponse(e, '撤回失敗');
  }
}
