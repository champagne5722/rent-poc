import { NextRequest } from 'next/server';
import { currentOwnerSession } from '@/lib/current-owner-session';
import { cloneDemoHandover, isDemoHandoverVariant } from '@/lib/handover/demo-clone';
import { handoverStore } from '@/lib/handover/demo-store';
import { jsonError, jsonOk, readJson } from '@/lib/http';
import { isMockMailerMode } from '@/lib/mailer';

// demo 專用：替目前登入的屋主建立一筆示範移交，讓畫面截圖與流程測試有資料可看（MIL-185）。
// 移交還在記憶體 adapter（MIL-105 接線前），資料綁在虛構屋主，真實登入的屋主看不到。
// 只在 Mock 模式存在，與 /api/demo/notify 相同：正式環境沒設定 MAILER_ADAPTER 一律 404。
// 只寫記憶體 store，不碰資料庫。接線 PostgreSQL adapter 時刪除這個 route。
export async function POST(request: NextRequest) {
  if (!isMockMailerMode()) return jsonError(404, '找不到頁面');
  const session = await currentOwnerSession();
  if (!session) return jsonError(403, '目前的帳號沒有屋主身分。');
  const raw = (await readJson(request)) ?? {};
  const variant = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).variant : undefined;
  if (!isDemoHandoverVariant(variant)) return jsonError(400, 'variant 必須是 draft、owner_confirmed 或 completed。');

  const store = handoverStore();
  const record = cloneDemoHandover(variant, session.partyId, store.newHandoverId());
  if (!record) return jsonError(500, '找不到示範移交的來源資料。');
  await store.saveHandover(record);
  return jsonOk({ data: { id: record.id } }, { status: 201 });
}
