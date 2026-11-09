import { NextRequest } from 'next/server';
import { jsonError, jsonOk, readJson } from '@/lib/http';
import { inOrgTxAs } from '@/lib/org-route';
import { changeRole, removeMember } from '@/lib/orgs/members';
import { isUlid } from '@/lib/pg/ulid';

type Ctx = { params: Promise<{ userId: string }> };

// 改角色、移除成員（MIL-106）。只有 admin。格式錯誤的 ID 與別的組織的帳號，回應相同。
const notFound = () => jsonError(404, '成員不存在');
const forbidden = () => jsonError(403, '只有組織管理員能管理成員');
const lastAdmin = () => jsonError(409, '組織至少要有一位管理員');

export async function PATCH(request: NextRequest, { params }: Ctx): Promise<Response> {
  const { userId } = await params;
  const body = (await readJson(request)) as { role?: unknown } | undefined;
  if (!body || typeof body !== 'object') return jsonError(400, '請求本文必須是 JSON');
  if (!isUlid(userId)) return notFound();
  return inOrgTxAs(async (tx, rc) => {
    const result = await changeRole(tx, rc, { userId, role: body.role });
    switch (result.status) {
      case 'changed':
      case 'unchanged':
        return jsonOk({ data: { role: body.role } });
      case 'forbidden':
        return forbidden();
      case 'invalid_role':
        return jsonError(400, '角色必須是管理員、業務人員或唯讀');
      case 'not_found':
        return notFound();
      case 'last_admin':
        return lastAdmin();
    }
  });
}

export async function DELETE(_request: NextRequest, { params }: Ctx): Promise<Response> {
  const { userId } = await params;
  if (!isUlid(userId)) return notFound();
  return inOrgTxAs(async (tx, rc) => {
    const result = await removeMember(tx, rc, { userId });
    switch (result.status) {
      case 'removed':
        return jsonOk({ data: { removed: true, self: userId === rc.userId } });
      case 'forbidden':
        return forbidden();
      case 'not_found':
        return notFound();
      case 'last_admin':
        return lastAdmin();
    }
  });
}
