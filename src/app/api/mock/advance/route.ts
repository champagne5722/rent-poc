import { NextRequest } from 'next/server';
import { contractNotFound } from '@/lib/contracts/route';
import { isUlid } from '@/lib/pg/ulid';
import { contractSubject, signing, signingErrorResponse } from '@/lib/signing-module';
import { jsonOk } from '@/lib/http';

// 僅 mock 模式可用：模擬點點簽 webhook 推進狀態（與真 webhook 走同一套轉移邏輯）。
// live 模式的 403 由簽署模組回覆，所以 body 解析失敗時，這裡不回錯誤。
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) ?? {};
  const contractId = body.contract_id;
  if (!isUlid(contractId)) return contractNotFound();
  try {
    const { status } = await signing.simulateEvent(contractSubject(contractId), body.event, body.reason);
    return jsonOk({ data: { id: contractId, status } });
  } catch (e) {
    return signingErrorResponse(e, '模擬簽署事件失敗');
  }
}
