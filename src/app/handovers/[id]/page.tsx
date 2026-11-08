// 後台移交詳情（MIL-98）：接收方確認接手；交出方看快照的唯讀副本；完成後兩方都能匯出。
import { notFound } from 'next/navigation';
import NoOrgSession from '../NoOrgSession';
import { currentPracticeOrgSession } from '@/lib/current-practice-org-session';
import { HANDOVER_SIMULATION_AVAILABLE, handoverStore } from '@/lib/handover/demo-store';
import { canSimulateEffective } from '@/lib/handover/demo-effective';
import { getOrgHandoverDetail } from '@/lib/handover/org-service';
import { taipeiDate } from '@/lib/handover/service';
import OrgHandoverDetailView from './OrgHandoverDetailView';

export default async function OrgHandoverDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await currentPracticeOrgSession();
  if (!session) return <NoOrgSession />;
  const { id } = await params;
  const detail = await getOrgHandoverDetail(handoverStore(), session.orgId, id);
  if (!detail) notFound();
  return (
    <OrgHandoverDetailView
      detail={detail}
      today={taipeiDate(new Date())}
      canSimulate={HANDOVER_SIMULATION_AVAILABLE && canSimulateEffective(detail)}
    />
  );
}
