import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import DemoOtpList, { type DemoMailRow } from '@/components/DemoOtpList';
import { recentLoggedMail } from '@/lib/mailer';

export const metadata: Metadata = { title: 'demo 驗證碼｜租房雲端管理平台' };

// demo 的最近驗證碼頁（ADR-0022 決議 3）。只在 Mailer 用 log adapter 時存在，其他 adapter 一律 404。
// 這頁不需要登入（要先拿到驗證碼才登入得了），保護靠外層的 Basic Auth（ADR-0011）。
// 真實寄信服務上線前必須換掉 log adapter，這頁隨之消失。
export default async function DemoOtpPage() {
  await connection();
  const mails = recentLoggedMail();
  if (!mails) notFound();

  const rows: DemoMailRow[] = mails.map((mail) => ({
    id: mail.id,
    sentAt: mail.sentAt.toISOString(),
    to: mail.to,
    kind: mail.kind,
    code: mail.text.match(/\d{6}/)?.[0] ?? null,
  }));
  return <DemoOtpList rows={rows} />;
}
