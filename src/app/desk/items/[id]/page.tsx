import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import CollisionReviewPanel from '@/components/CollisionReviewPanel';
import CredentialReviewPanel from '@/components/CredentialReviewPanel';
import DeskItemPanel from '@/components/DeskItemPanel';
import NoAccess from '@/components/page/NoAccess';
import { loadDeskItem, type DeskItemLoad } from '@/lib/practice-entities/desk-load';
import { Unauthenticated } from '@/lib/request-context';

export const metadata: Metadata = { title: '核對｜租房雲端管理平台' };

// 審核項目詳情（MIL-109、MIL-111、MIL-144、MIL-180）。資料在 server component 載入，依項目類型選畫面：
// 業別核對與統編認領、證書與任職與同意書、撞號。出租權源項目有自己的路由。
// 載入中的骨架畫面在 loading.tsx，失敗畫面在 error.tsx，找不到的畫面在 not-found.tsx。
export default async function DeskItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let result: DeskItemLoad;
  try {
    result = await loadDeskItem(id);
  } catch (error) {
    // layout 只在整頁載入時檢查登入，client 端換頁時 session 可能已失效
    if (!(error instanceof Unauthenticated)) throw error;
    redirect(`/login?next=${encodeURIComponent(`/desk/items/${id}`)}`);
  }
  switch (result.kind) {
    case 'not_found':
      notFound();
    case 'forbidden':
      return <NoAccess title="審核項目" description="只有平台營運者身分能開啟審核台。請從右上角切換身分。" />;
    case 'ownership':
      redirect(`/desk/ownership/${result.id}`);
    case 'credential':
      return <CredentialReviewPanel review={result.review} nowIso={result.nowIso} />;
    case 'collision':
      return <CollisionReviewPanel detail={result.detail} nowIso={result.nowIso} />;
    case 'review':
      return <DeskItemPanel detail={result.detail} nowIso={result.nowIso} />;
  }
}
