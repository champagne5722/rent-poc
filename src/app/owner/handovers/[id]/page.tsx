// 移交詳情（MIL-97）：草稿時檢查六類、缺項與擋下原因並確認；之後顯示兩側狀態，生效前能取消。
import { notFound } from 'next/navigation';
import { currentOwnerSession } from '@/lib/current-owner-session';
import { handoverStore } from '@/lib/handover/demo-store';
import { getHandoverDetail, taipeiDate } from '@/lib/handover/service';
import HandoverDetailView from './HandoverDetailView';

export default async function HandoverDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await currentOwnerSession();
  if (!session) return null;
  const { id } = await params;
  const detail = await getHandoverDetail(handoverStore(), session.partyId, id);
  if (!detail) notFound();
  return <HandoverDetailView detail={detail} today={taipeiDate(new Date())} />;
}
