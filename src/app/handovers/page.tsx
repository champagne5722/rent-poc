// 後台「移交」清單（MIL-98）。殼層是後台殼層。不加進側邊選單，避免與 C、D 線改 nav 衝突。
import NoOrgSession from './NoOrgSession';
import { currentPracticeOrgSession } from '@/lib/current-practice-org-session';
import { handoverStore } from '@/lib/handover/demo-store';
import { listOrgHandovers } from '@/lib/handover/org-service';
import OrgHandoverList from './OrgHandoverList';

export default async function HandoversPage() {
  const session = await currentPracticeOrgSession();
  if (!session) return <NoOrgSession />;
  const { incoming, outgoing } = await listOrgHandovers(handoverStore(), session.orgId);
  return <OrgHandoverList orgName={session.name} incoming={incoming} outgoing={outgoing} />;
}
