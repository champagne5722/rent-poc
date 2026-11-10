import { authorize } from '@/lib/authorize';
import { jsonError, jsonOk } from '@/lib/http';
import { inOrgTxAs } from '@/lib/org-route';
import { getPractitionerMe } from '@/lib/practitioners/me';
import { PRACTICE_ONLY_MESSAGE } from '@/lib/practitioners/route';

// 我的證書：本人的證書與目前組織的任職、個資告知與同意狀態、執業主體的任職清單（MIL-111）。
// 只有 practice 組織。回應只含本人的資料與目前組織的任職，不透露別的組織（ADR-0012 決議 8）。
// 資料組裝在 getPractitionerMe，「我的證書」頁（MIL-181）共用。

export async function GET(): Promise<Response> {
  return inOrgTxAs(async (tx, rc) => {
    await authorize(tx, 'practitioner.read', { type: 'org' });
    if (rc.orgKind !== 'practice') return jsonError(403, PRACTICE_ONLY_MESSAGE);
    return jsonOk({ data: await getPractitionerMe(tx, rc) });
  });
}
