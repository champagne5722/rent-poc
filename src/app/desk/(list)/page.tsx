import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import DeskQueue from '@/components/DeskQueue';
import NoAccess from '@/components/page/NoAccess';
import { loadDeskQueue, type DeskQueueLoad } from '@/lib/practice-entities/desk-load';
import { Unauthenticated } from '@/lib/request-context';

export const metadata: Metadata = { title: '審核台｜租房雲端管理平台' };

// 審核台佇列（MIL-109、MIL-180）。資料在 server component 載入，DeskQueue 只管篩選與連結。
// 載入中的骨架畫面在同資料夾的 loading.tsx。只有平台營運者身分能開啟。
export default async function DeskPage() {
  let result: DeskQueueLoad;
  try {
    result = await loadDeskQueue();
  } catch (error) {
    // layout 只在整頁載入時檢查登入，client 端換頁時 session 可能已失效
    if (!(error instanceof Unauthenticated)) throw error;
    redirect('/login?next=%2Fdesk');
  }
  if (result.kind === 'forbidden') {
    return <NoAccess title="審核項目列表" description="只有平台營運者身分能開啟審核台。請從右上角切換身分。" />;
  }
  return <DeskQueue open={result.open} resolved={result.resolved} />;
}
