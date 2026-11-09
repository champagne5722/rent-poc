import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import DemoMailList, { type DemoMailRow } from './DemoMailList';
import { listMockMail } from '@/lib/mailer';

export const metadata: Metadata = { title: 'demo 寄件紀錄｜租房雲端管理平台' };

// demo 的寄件紀錄頁（ADR-0050 決議 12，MIL-120）。只在 Mailer 是 Mock 模式時存在，其他情況一律 404。
// 真實寄信服務上線後（上線閘門）這頁隨之消失。保護靠外層的 Basic Auth（ADR-0011）。
export default async function DemoMailPage() {
  await connection();
  const mails = await listMockMail();
  if (!mails) notFound();

  const rows: DemoMailRow[] = mails.map((mail) => ({
    id: mail.id,
    sentAt: mail.sentAt.toISOString(),
    from: mail.from ?? null,
    to: mail.to,
    kind: mail.kind,
    subject: mail.subject,
    text: mail.text,
  }));
  return <DemoMailList rows={rows} />;
}
