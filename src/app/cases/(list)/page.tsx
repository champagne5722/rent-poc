import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import CaseList from '@/components/CaseList';
import { loadCaseList, type CaseListLoad } from '@/lib/case-list-load';
import { Unauthenticated } from '@/lib/request-context';
import ForbiddenList from './ForbiddenList';

export const metadata: Metadata = { title: '案件列表｜租房雲端管理平台' };

// 案件列表（MIL-115、MIL-184）：目前組織主辦的案件，加上自己是成員的別組織案件（ADR-0023 決議 1）。
// 資料在 server component 載入，CaseList 只管狀態分組與欄位。載入中的骨架畫面在同資料夾的 loading.tsx。
// 這頁放在 (list) 路由群組，讓骨架只套用在列表，不套用到 /cases/[id]。
export default async function CasesPage() {
  let result: CaseListLoad;
  try {
    result = await loadCaseList();
  } catch (error) {
    // layout 只在整頁載入時檢查登入，client 端換頁時 session 可能已失效
    if (!(error instanceof Unauthenticated)) throw error;
    redirect('/login?next=%2Fcases');
  }
  if (result.kind === 'forbidden') return <ForbiddenList />;
  return <CaseList rows={result.rows} />;
}
