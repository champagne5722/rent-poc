import { NextRequest } from 'next/server';
import { contractIdOf, contractNotFound, type ContractRouteCtx } from '@/lib/contracts/route';
import { contractSubject, signing, signingErrorResponse } from '@/lib/signing-module';
import { jsonOk } from '@/lib/http';

// 簽署連結現查（見 GLOSSARY.md「簽署連結」）：email 沒收到時的備案。
// 向簽署服務商要當前簽署人的連結，簽完導回合約頁。
export async function GET(request: NextRequest, { params }: ContractRouteCtx) {
  const id = await contractIdOf(params);
  if (!id) return contractNotFound();
  // standalone 在反向代理後方時，request.url 的 origin 是 0.0.0.0:<port>，所以部署環境必須設定 APP_ORIGIN
  const origin = process.env.APP_ORIGIN ?? new URL(request.url).origin;
  const redirectUrl = `${origin}/contracts/${id}`;
  try {
    const { signer, url } = await signing.getSignLink(contractSubject(id), redirectUrl);
    return jsonOk({
      data: { role: signer.role, name: signer.name, email: signer.email, sign_link: url },
    });
  } catch (e) {
    return signingErrorResponse(e, '取得簽署連結失敗');
  }
}
