import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import MembersPanel from '@/components/MembersPanel';
import NoAccess from '@/components/page/NoAccess';
import { loadMemberPage, type MemberPageLoad } from '@/lib/orgs/members-load';
import { Unauthenticated } from '@/lib/request-context';

export const metadata: Metadata = { title: '成員管理｜租房雲端管理平台' };

// 組織成員管理（MIL-106、MIL-181）。資料在 server component 載入，MembersPanel 只管操作。
// 載入中的骨架畫面在同資料夾的 loading.tsx。權限在 /api/org/* 的 route 與載入函式判斷。
export default async function MembersPage() {
  let result: MemberPageLoad;
  try {
    result = await loadMemberPage();
  } catch (error) {
    // layout 只在整頁載入時檢查登入，client 端換頁時 session 可能已失效
    if (!(error instanceof Unauthenticated)) throw error;
    redirect('/login?next=%2Fsettings%2Fmembers');
  }
  if (result.kind === 'forbidden') {
    return <NoAccess title="成員管理" description="目前的身分不是組織成員，沒有成員清單。請從右上角切換到組織身分。" />;
  }
  return <MembersPanel members={result.members} invitations={result.invitations} me={result.me} />;
}
