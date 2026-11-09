import { authorize } from '@/lib/authorize';
import { jsonError, jsonOk } from '@/lib/http';
import { inOrgTxAs } from '@/lib/org-route';
import { applicantMayRead, applicantMayWrite, getMyRegistration } from '@/lib/practice-entities';

// 執業主體端：目前組織的登錄與各業別的進度（MIL-109）。只有 practice 組織。
// 登錄者與第二個組織認領同一統編的認領方，回應形狀與欄位相同，不透露別的組織（ADR-0012 決議 8）。

export async function GET(): Promise<Response> {
  return inOrgTxAs(async (tx, rc) => {
    await authorize(tx, 'practice_registry.read', { type: 'org' });
    if (!applicantMayRead(rc)) return jsonError(403, '只有執業主體組織能看登錄進度');
    return jsonOk({ data: { registration: await getMyRegistration(tx), canSubmit: applicantMayWrite(rc) } });
  });
}
