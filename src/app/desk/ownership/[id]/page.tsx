import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { Flex } from 'antd';
import OwnershipReviewPanel from '@/components/OwnershipReviewPanel';
import EmptyState from '@/components/page/EmptyState';
import PageHeader from '@/components/page/PageHeader';
import { loadOwnershipReview, type OwnershipReviewLoad } from '@/lib/ownership/desk-load';
import { Unauthenticated } from '@/lib/request-context';

export const metadata: Metadata = { title: '出租權源核對｜租房雲端管理平台' };

// 審核台的出租權源核對（MIL-201）。資料在 server component 載入，OwnershipReviewPanel 只管畫面與操作。
// 載入中的骨架畫面在同資料夾的 loading.tsx，失敗畫面在 error.tsx，找不到的畫面在 not-found.tsx。
export default async function OwnershipReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let result: OwnershipReviewLoad;
  try {
    result = await loadOwnershipReview(id);
  } catch (error) {
    // layout 只在整頁載入時檢查登入，client 端換頁時 session 可能已失效
    if (!(error instanceof Unauthenticated)) throw error;
    redirect(`/login?next=${encodeURIComponent(`/desk/ownership/${id}`)}`);
  }
  if (result.kind === 'not_found') notFound();
  if (result.kind === 'forbidden') {
    return (
      <Flex vertical gap="large">
        <PageHeader title="出租權源核對" back={{ href: '/desk', label: '返回審核台' }} />
        <EmptyState description="只有平台營運者身分能開啟審核台。請從右上角切換身分。" />
      </Flex>
    );
  }
  return <OwnershipReviewPanel detail={result.detail} />;
}
