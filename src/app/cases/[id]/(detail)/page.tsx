import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import CaseDetail from '@/components/CaseDetail';
import { loadCaseDetail, type CaseDetailLoad } from '@/lib/case-detail-load';
import { Unauthenticated } from '@/lib/request-context';
import ForbiddenDetail from './ForbiddenDetail';

export const metadata: Metadata = { title: '案件詳情｜租房雲端管理平台' };

// 案件詳情（MIL-115、MIL-184）：主辦組織的成員看得到全部，管理員與業務人員能加入共同承租人。
// 資料在 server component 載入，CaseDetail 只管畫面與操作。載入中的骨架畫面在同資料夾的 loading.tsx。
export default async function CaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let result: CaseDetailLoad;
  try {
    result = await loadCaseDetail(id);
  } catch (error) {
    // layout 只在整頁載入時檢查登入，client 端換頁時 session 可能已失效
    if (!(error instanceof Unauthenticated)) throw error;
    redirect(`/login?next=${encodeURIComponent(`/cases/${id}`)}`);
  }
  if (result.kind === 'not_found') notFound();
  if (result.kind === 'forbidden') return <ForbiddenDetail />;
  const { kind: _kind, ...detail } = result;
  void _kind;
  return <CaseDetail caseId={id} detail={detail} backHref="/cases" />;
}
