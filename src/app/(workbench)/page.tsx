import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Workbench from '@/components/Workbench';
import EmptyState from '@/components/page/EmptyState';
import PageHeader from '@/components/page/PageHeader';
import { loadWorkbench, type WorkbenchLoad } from '@/lib/workbench-load';
import { Unauthenticated } from '@/lib/request-context';

export const metadata: Metadata = { title: '工作台｜租房雲端管理平台' };

// 工作台（MIL-178）。資料在 server component 載入，Workbench 只管畫面。
// 載入中的骨架畫面在同資料夾的 loading.tsx。這頁放在 (workbench) 路由群組，骨架只套用在 "/"。
export default async function WorkbenchPage() {
  let result: WorkbenchLoad;
  try {
    result = await loadWorkbench();
  } catch (error) {
    // layout 只在整頁載入時檢查登入，client 端換頁時 session 可能已失效
    if (!(error instanceof Unauthenticated)) throw error;
    redirect('/login');
  }
  if (result.kind === 'forbidden') {
    return (
      <>
        <PageHeader title="待處理的事" />
        <EmptyState description="目前的身分沒有查看合約的權限。請從右上角切換身分。" />
      </>
    );
  }
  return <Workbench contracts={result.contracts} progress={result.progress} propertyCount={result.propertyCount} />;
}
