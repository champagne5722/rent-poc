import { NextRequest } from 'next/server';
import { jsonError, jsonOk } from '@/lib/http';
import { isMockMailerMode } from '@/lib/mailer';
import { dispatchNotificationEmail, notify, NotifyInputError, type NotifyReceipt } from '@/lib/notifications';
import { inMemberTx } from '@/lib/notifications/member-route';
import { readJson } from '@/lib/org-route';

// demo 專用：送一則測試通知（站內通知加 email），讓人在寄件紀錄頁看到結果（MIL-120）。
// 只在 Mock 模式存在。真實寄信服務上線後（或正式環境沒設定 MAILER_ADAPTER）一律 404。
export async function POST(request: NextRequest) {
  if (!isMockMailerMode()) return jsonError(404, '找不到頁面');
  const raw = (await readJson(request)) ?? {};
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const text = (key: string, fallback: string) => (typeof input[key] === 'string' && input[key] !== '' ? (input[key] as string) : fallback);

  let receipt: NotifyReceipt | undefined;
  let orgId: string | undefined;
  const response = await inMemberTx(async (tx, member) => {
    orgId = member.orgId;
    try {
      receipt = await notify(tx, {
        kind: 'demo.test',
        title: text('title', '測試通知'),
        body: text('body', '這是示範用的測試通知，信件只會出現在寄件紀錄頁。'),
        linkPath: '/demo/mail',
        email: { to: text('to', 'tenant@example.com'), from: text('from', '示範管理公司') },
      });
    } catch (e) {
      if (e instanceof NotifyInputError) return jsonError(400, e.message);
      throw e;
    }
    return jsonOk({ data: { ok: true } }, { status: 201 });
  });
  // 交易提交後才派送（ADR-0020 決議 5）
  if (!receipt || !orgId) return response;
  const dispatched = await dispatchNotificationEmail(orgId, receipt.outboxId);
  return jsonOk({ data: { notificationId: receipt.notificationId, delivery: dispatched.kind } }, { status: 201 });
}
