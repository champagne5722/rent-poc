import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import PracticePanel from '@/components/PracticePanel';
import NoAccess from '@/components/page/NoAccess';
import { loadPracticePage, type PracticePageLoad } from '@/lib/practice-entities/page-load';
import { Unauthenticated } from '@/lib/request-context';

export const metadata: Metadata = { title: '執業主體｜租房雲端管理平台' };

// 執業主體的登錄進度與送件（MIL-109、MIL-181）。資料在 server component 載入，PracticePanel 只管送件。
// 載入中的骨架畫面在同資料夾的 loading.tsx。權限在 /api/practice/* 的 route 與載入函式判斷。
export default async function PracticePage() {
  let result: PracticePageLoad;
  try {
    result = await loadPracticePage();
  } catch (error) {
    // layout 只在整頁載入時檢查登入，client 端換頁時 session 可能已失效
    if (!(error instanceof Unauthenticated)) throw error;
    redirect('/login?next=%2Fpractice');
  }
  if (result.kind === 'forbidden') {
    return <NoAccess title="執業主體登錄" description="目前的身分不是執業主體組織。請從右上角切換身分。" />;
  }
  return (
    <PracticePanel
      registration={result.registration}
      canSubmit={result.canSubmit}
      orgEmployments={result.orgEmployments}
      isAdmin={result.isAdmin}
    />
  );
}
