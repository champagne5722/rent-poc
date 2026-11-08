import { getDb } from '@/lib/db';
import { jsonOk } from '@/lib/http';

// Cloud Run startup probe 用。能開 SQLite 才算就緒，不對外透露其他資訊。
export async function GET() {
  try {
    getDb().prepare('SELECT 1').get();
    return jsonOk({ ok: true });
  } catch (e) {
    console.error('[health] SQLite 無法使用', e);
    return jsonOk({ ok: false }, { status: 503 });
  }
}
