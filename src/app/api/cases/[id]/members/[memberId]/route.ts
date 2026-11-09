import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { getCase, normalizePartyEmail, replaceTenantMemberEmail } from '@/lib/case-store';
import { caseIdOf, caseNotFound } from '@/lib/case-store/route';
import { jsonError, jsonOk } from '@/lib/http';
import { inOrgTxAs, readJson } from '@/lib/org-route';
import { isUlid } from '@/lib/pg/ulid';

// 更新承租人或共同承租人的 email（MIL-121，ADR-0023 決議 5，P0-21 AC5）。
// 權限是 case_member.manage：主辦組織的 admin、staff（出租人或受託人所屬組織），案件在結案前。
// 舊成員列關閉，舊 email 立即失效。新 email 找或建 party，加一列同關係的新成員。同一個交易，寫案件事件與稽核事件。
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; memberId: string }> }) {
  const { memberId } = await params;
  const id = await caseIdOf(params);
  if (!id) return caseNotFound();
  const body = await readJson(request);
  const input = typeof body === 'object' && body !== null ? (body as { email?: unknown; name?: unknown }) : {};
  return inOrgTxAs(async (tx, rc) => {
    await authorize(tx, 'case_member.manage', { type: 'case', id });
    const record = await getCase(tx, id);
    if (!record || record.kind !== 'lease') return caseNotFound();
    if (!isUlid(memberId)) return jsonError(404, '成員不存在');

    const email = typeof input.email === 'string' ? normalizePartyEmail(input.email) : null;
    if (!email) return jsonError(400, '請填寫有效的 email');
    const displayName = typeof input.name === 'string' ? input.name : undefined;

    const result = await replaceTenantMemberEmail(tx, id, memberId, { email, displayName }, { actor: { partyId: rc.partyId } });
    if (result.ok) return jsonOk({ data: { partyId: result.newPartyId } });
    switch (result.reason) {
      case 'member_not_found':
        return jsonError(404, '成員不存在');
      case 'same_email':
        return jsonError(409, '新的 email 與目前相同');
      case 'already_member':
        return jsonError(409, '這個 email 已經是案件的有效成員');
      case 'not_active':
      case 'not_tenant':
        return jsonError(409, '只有有效的承租人或共同承租人能更新 email');
    }
  });
}
