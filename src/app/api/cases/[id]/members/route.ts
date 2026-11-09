import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { addCaseMember, findOrCreateParty, getCase, normalizePartyEmail } from '@/lib/case-store';
import { caseIdOf, caseNotFound, type CaseRouteCtx } from '@/lib/case-store/route';
import { jsonError, jsonOk } from '@/lib/http';
import { inOrgTxAs, readJson } from '@/lib/org-route';

// 出租人加入共同承租人（MIL-115，ADR-0023 決議 5）。權限是 case_member.manage：主辦組織的 admin、staff。
// 本票只開放共同承租人。簽章人員與經紀業者的指派屬 MIL-116。
export async function POST(request: NextRequest, { params }: CaseRouteCtx) {
  const id = await caseIdOf(params);
  if (!id) return caseNotFound();
  const body = await readJson(request);
  const input = typeof body === 'object' && body !== null ? (body as { email?: unknown; name?: unknown }) : {};
  return inOrgTxAs(async (tx, rc) => {
    await authorize(tx, 'case_member.manage', { type: 'case', id });
    const record = await getCase(tx, id);
    if (!record || record.kind !== 'lease') return caseNotFound();

    const email = typeof input.email === 'string' ? normalizePartyEmail(input.email) : null;
    if (!email) return jsonError(400, '請填寫有效的 email');
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) return jsonError(400, '請填寫共同承租人的姓名');

    const partyId = await findOrCreateParty(tx, email, name);
    const added = await addCaseMember(tx, id, { partyId, relation: 'co_lessee' }, { actor: { partyId: rc.partyId } });
    if (!added) return jsonError(409, '這位共同承租人已經在案件中');
    return jsonOk({ data: { partyId } }, { status: 201 });
  });
}
