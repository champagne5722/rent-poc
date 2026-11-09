import { withTx } from '@/lib/pg/database';
import { jsonOk } from '@/lib/http';

// Cloud Run startup probe 用。能連上 PostgreSQL 才算就緒，不對外透露其他資訊。
export async function GET() {
  try {
    await withTx({ kind: 'control' }, (tx) => tx.query('SELECT 1'));
    return jsonOk({ ok: true });
  } catch (e) {
    console.error('[health] PostgreSQL 無法使用', e);
    return jsonOk({ ok: false }, { status: 503 });
  }
}
