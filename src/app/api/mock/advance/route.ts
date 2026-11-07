import { NextRequest } from 'next/server';
import { contractSubject, signing, signingErrorResponse } from '@/lib/signing-module';

// 僅 mock 模式可用：模擬點點簽 webhook 推進狀態（與真 webhook 走同一套轉移邏輯）。
// live 模式的 403 由簽署模組回覆，所以 body 解析失敗時，這裡不回錯誤。
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) ?? {};
  const contractId = Number(body.contract_id);
  try {
    const { status } = await signing.simulateEvent(contractSubject(contractId), body.event, body.reason);
    return Response.json({ data: { id: contractId, status } });
  } catch (e) {
    return signingErrorResponse(e, '模擬簽署事件失敗');
  }
}
