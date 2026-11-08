import { NextRequest } from 'next/server';
import { signing } from '@/lib/signing-module';
import { jsonOk } from '@/lib/http';

// 點點簽 webhook 接收端。開發期需以 cloudflared/ngrok 開通道，
// 並把公開 URL 設定在點點簽開發者後台的 Application 上。
// ping、簽章驗證與 payload 解析都在 adapter，見 signing-module/dottedsign-adapter.ts。
export async function POST(request: NextRequest) {
  const ack = await signing.ingestWebhook(await request.text(), request.headers);
  return jsonOk(ack.body, { status: ack.status });
}
