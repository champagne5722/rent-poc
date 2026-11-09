import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { removeRemitterId } from '@/lib/case-ledger';
import { caseIdOf, caseNotFound } from '@/lib/case-store/route';
import { jsonError, jsonOk } from '@/lib/http';
import { inOrgTx } from '@/lib/org-route';
import { isUlid } from '@/lib/pg/ulid';

// 移除匯款識別（MIL-123）。權限是 ledger.configure_case。
// 識別不存在、屬於別的案件、屬於別的組織，回應逐位元相同。
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string; remitterId: string }> }) {
  const resolved = await params;
  const id = await caseIdOf(Promise.resolve(resolved));
  if (!id) return caseNotFound();
  if (!isUlid(resolved.remitterId)) return jsonError(404, '找不到這筆匯款識別');
  return inOrgTx(async (tx) => {
    await authorize(tx, 'ledger.configure_case', { type: 'case', id });
    const removed = await removeRemitterId(tx, id, resolved.remitterId);
    return removed ? jsonOk({ data: { ok: true } }) : jsonError(404, '找不到這筆匯款識別');
  });
}
