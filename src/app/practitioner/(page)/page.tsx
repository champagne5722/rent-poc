import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import PractitionerPanel from '@/components/PractitionerPanel';
import NoAccess from '@/components/page/NoAccess';
import { loadPractitionerPage, type PractitionerPageLoad } from '@/lib/practitioners/page-load';
import { Unauthenticated } from '@/lib/request-context';

export const metadata: Metadata = { title: '我的證書｜租房雲端管理平台' };

// 執業人員本人的證書登錄、任職與補件（MIL-111、MIL-181）。資料在 server component 載入，PractitionerPanel 只管登錄與操作。
// 載入中的骨架畫面在同資料夾的 loading.tsx。權限在 /api/practitioner/* 的 route 與載入函式判斷。
export default async function PractitionerPage() {
  let result: PractitionerPageLoad;
  try {
    result = await loadPractitionerPage();
  } catch (error) {
    // layout 只在整頁載入時檢查登入，client 端換頁時 session 可能已失效
    if (!(error instanceof Unauthenticated)) throw error;
    redirect('/login?next=%2Fpractitioner');
  }
  if (result.kind === 'forbidden') {
    return <NoAccess title="我的證書登錄" description="目前的身分不是執業主體組織。請從右上角切換身分。" />;
  }
  return <PractitionerPanel data={result} />;
}
