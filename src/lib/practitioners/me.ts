import { currentNotice, NOTICE_CATALOG } from '../consent';
import type { OrgTx } from '../pg/with-tx';
import type { RequestContext } from '../request-context';
import { getCertificateConsent, getMyPractitioner, listOrgEmployments } from './applicant';
import { taiwanDate } from './dates';

// 「我的證書」頁與 GET /api/practitioner/me 共用的資料組裝（MIL-111、MIL-181）。
// 呼叫端先過 authorize('practitioner.read') 並確認是 practice 組織。回應只含本人的資料與目前組織的任職，不透露別的組織（ADR-0012 決議 8）。

export async function getPractitionerMe(tx: OrgTx, rc: Extract<RequestContext, { kind: 'org' }>) {
  const notice = currentNotice(NOTICE_CATALOG, 'certificate_pii');
  const [mine, consent, orgEmployments] = await Promise.all([getMyPractitioner(tx), getCertificateConsent(tx, rc.partyId), listOrgEmployments(tx)]);
  return {
    entityRegistered: mine.entityRegistered,
    certificates: mine.certificates,
    myEmployments: mine.employments,
    orgEmployments,
    consent,
    notice: { version: notice.version, title: notice.title, text: notice.text, legalReview: notice.legalReview },
    canWrite: rc.role === 'admin' || rc.role === 'staff',
    isAdmin: rc.role === 'admin',
    today: taiwanDate(new Date()),
  };
}

export type PractitionerMe = Awaited<ReturnType<typeof getPractitionerMe>>;
