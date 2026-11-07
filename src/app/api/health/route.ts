import { getDb } from '@/lib/db';

// Cloud Run startup probe 用。能開 SQLite 才算就緒，不對外透露其他資訊。
export async function GET() {
  try {
    getDb().prepare('SELECT 1').get();
    return Response.json({ ok: true });
  } catch (e) {
    console.error('[health] SQLite 無法使用', e);
    return Response.json({ ok: false }, { status: 503 });
  }
}
