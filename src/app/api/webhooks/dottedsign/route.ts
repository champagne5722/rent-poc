import { NextRequest } from 'next/server';
import { findContractByTaskId } from '@/lib/db';
import { verifyWebhookSignature } from '@/lib/dottedsign';
import { applyDsEvent, DsEvent } from '@/lib/transitions';
import { saveContractFilesOnCompleted } from '@/lib/contract-files';

// 點點簽 webhook 接收端。開發期需以 cloudflared/ngrok 開通道，
// 並把公開 URL 設定在點點簽開發者後台的 Application 上。
// payload 欄位：resource_id / resource_type / action_name（見整合筆記）。
export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  // 後台儲存 webhook URL 時會送一記空 body 的驗證 ping（無簽章 header），需回 200 否則註冊失敗（實測踩過）
  if (!rawBody) return Response.json({ ok: true, ping: true });

  // 簽章 header 實測為 `Signature`，值 = HMAC-SHA256(client_secret, raw body) 的 hex（見整合筆記）
  const signature = request.headers.get('signature');
  if (!verifyWebhookSignature(rawBody, signature)) {
    return Response.json({ error: 'invalid signature' }, { status: 401 });
  }

  let payload: { resource_id?: unknown; resource_type?: string; action_name?: string; reason?: unknown };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: 'invalid json' }, { status: 400 });
  }

  const { resource_id, resource_type, action_name } = payload;
  if (resource_type !== 'task' || resource_id == null || !action_name) {
    return Response.json({ ok: true, ignored: true });
  }

  const contract = findContractByTaskId(String(resource_id));
  if (!contract) return Response.json({ ok: true, ignored: true });

  const eventMap: Record<string, DsEvent> = {
    signed: 'signed',
    completed: 'completed',
    declined: 'declined',
    voided: 'voided',
  };
  const event = eventMap[action_name];
  // 狀態轉移與合約歷程事件同交易寫入（ADR-0007）。
  // 拒簽原因：sandbox 實測的 payload 未帶，若正式環境有 reason 欄位就一併記進附註。
  const reason = typeof payload.reason === 'string' ? payload.reason : undefined;
  const next = event ? applyDsEvent(contract, event, reason) : null;

  // 完成後保存已簽 PDF 與 Audit Trail File：外部 IO，放在狀態轉移的交易之外，
  // 失敗不回滾狀態（只記錄，可用 POST /api/contracts/[id]/files 補抓）
  if (next === 'completed') await saveContractFilesOnCompleted(contract);

  return Response.json({ ok: true });
}
