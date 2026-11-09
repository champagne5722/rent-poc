import { authorize } from '@/lib/authorize';
import { currentNotice, NOTICE_CATALOG } from '@/lib/consent';
import { jsonError, jsonOk } from '@/lib/http';
import { inOrgTxAs } from '@/lib/org-route';
import { getCertificateConsent, getMyPractitioner, listOrgEmployments } from '@/lib/practitioners/applicant';
import { taiwanDate } from '@/lib/practitioners/dates';
import { PRACTICE_ONLY_MESSAGE } from '@/lib/practitioners/route';

// 我的證書：本人的證書與目前組織的任職、個資告知與同意狀態、執業主體的任職清單（MIL-111）。
// 只有 practice 組織。回應只含本人的資料與目前組織的任職，不透露別的組織（ADR-0012 決議 8）。

export async function GET(): Promise<Response> {
  return inOrgTxAs(async (tx, rc) => {
    await authorize(tx, 'practitioner.read', { type: 'org' });
    if (rc.orgKind !== 'practice') return jsonError(403, PRACTICE_ONLY_MESSAGE);
    const notice = currentNotice(NOTICE_CATALOG, 'certificate_pii');
    const [mine, consent, orgEmployments] = await Promise.all([getMyPractitioner(tx), getCertificateConsent(tx, rc.partyId), listOrgEmployments(tx)]);
    return jsonOk({
      data: {
        entityRegistered: mine.entityRegistered,
        certificates: mine.certificates,
        myEmployments: mine.employments,
        orgEmployments,
        consent,
        notice: { version: notice.version, title: notice.title, text: notice.text, legalReview: notice.legalReview },
        canWrite: rc.role === 'admin' || rc.role === 'staff',
        isAdmin: rc.role === 'admin',
        today: taiwanDate(new Date()),
      },
    });
  });
}
