import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { OwnerRequestList, PracticeRequestList } from '@/components/mandate-requests/RequestList';
import NoAccess from '@/components/page/NoAccess';
import { loadRequestList, type RequestListLoad } from '@/lib/mandate-requests/page-load';
import { Unauthenticated } from '@/lib/request-context';

export const metadata: Metadata = { title: '申請列表｜租房雲端管理平台' };

// 申請列表（MIL-206 畫面段）。業者與屋主共用這個路徑，依組織的種類顯示各自的內容。
// 資料在 server component 載入，載入中的骨架畫面在同資料夾的 loading.tsx。
export default async function RequestsPage() {
  let result: RequestListLoad;
  try {
    result = await loadRequestList();
  } catch (error) {
    // layout 只在整頁載入時檢查登入，client 端換頁時 session 可能已失效
    if (!(error instanceof Unauthenticated)) throw error;
    redirect('/login?next=%2Frequests');
  }
  if (result.kind === 'forbidden') {
    return <NoAccess title="申請列表" description="目前的身分不是業者或屋主的組織。請從右上角切換身分。" />;
  }
  if (result.kind === 'owner') return <OwnerRequestList requests={result.requests} />;
  return <PracticeRequestList requests={result.requests} canCreate={result.creatableKinds.length > 0} />;
}
