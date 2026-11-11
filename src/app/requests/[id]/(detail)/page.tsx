import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import OwnerRequestDetail from '@/components/mandate-requests/OwnerRequestDetail';
import PracticeRequestDetail from '@/components/mandate-requests/PracticeRequestDetail';
import NoAccess from '@/components/page/NoAccess';
import { loadRequestDetail, type RequestDetailLoad } from '@/lib/mandate-requests/page-load';
import { Unauthenticated } from '@/lib/request-context';
import RequestNotFound from './RequestNotFound';

export const metadata: Metadata = { title: '申請詳情｜租房雲端管理平台' };

// 申請詳情（MIL-206 畫面段）。站內通知的連結指到這裡。業者與屋主共用路徑，依組織的種類顯示各自的內容。
// 不是自己的申請與不存在的申請，畫面相同。
export default async function RequestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let result: RequestDetailLoad;
  try {
    result = await loadRequestDetail(id);
  } catch (error) {
    if (!(error instanceof Unauthenticated)) throw error;
    redirect(`/login?next=${encodeURIComponent(`/requests/${id}`)}`);
  }
  switch (result.kind) {
    case 'forbidden':
      return <NoAccess title="申請詳情" description="目前的身分不是業者或屋主的組織。請從右上角切換身分。" />;
    case 'not_found':
      return <RequestNotFound />;
    case 'owner':
      return <OwnerRequestDetail initial={result.request} groups={result.groups} />;
    case 'practice':
      return <PracticeRequestDetail request={result.request} />;
  }
}
