import { NextRequest } from 'next/server';
import { contractSubject, signing, signingErrorResponse } from '@/lib/signing-module';

type Ctx = { params: Promise<{ id: string }> };

// 簽署連結現查（見 GLOSSARY.md「簽署連結」）：email 沒收到時的備案。
// 向簽署服務商要當前簽署人的連結，簽完導回合約頁。
export async function GET(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const contractId = Number(id);
  const redirectUrl = `${new URL(request.url).origin}/contracts/${contractId}`;
  try {
    const { signer, url } = await signing.getSignLink(contractSubject(contractId), redirectUrl);
    return Response.json({
      data: { role: signer.role, name: signer.name, email: signer.email, sign_link: url },
    });
  } catch (e) {
    return signingErrorResponse(e, '取得簽署連結失敗');
  }
}
