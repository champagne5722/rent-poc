// 發起移交（MIL-97）：屋主選擇委託管理案件，系統逐案產生移交包草稿。
import { currentOwnerSession } from '@/lib/current-owner-session';
import { handoverStore } from '@/lib/handover/demo-store';
import { listInitiatableMandates } from '@/lib/handover/service';
import StartHandoverForm from './StartHandoverForm';

export default async function NewHandoverPage() {
  const session = await currentOwnerSession();
  if (!session) return null;
  const mandates = await listInitiatableMandates(handoverStore(), session.partyId);
  return <StartHandoverForm mandates={mandates} />;
}
