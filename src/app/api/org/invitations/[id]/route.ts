import { NextRequest } from 'next/server';
import { jsonError, jsonOk } from '@/lib/http';
import { inOrgTxAs } from '@/lib/org-route';
import { cancelInvitation } from '@/lib/orgs/members';
import { isUlid } from '@/lib/pg/ulid';

type Ctx = { params: Promise<{ id: string }> };

// 撤銷待處理的邀請（MIL-106）。只有 admin。

export async function DELETE(_request: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  if (!isUlid(id)) return jsonError(404, '邀請不存在');
  return inOrgTxAs(async (tx, rc) => {
    const result = await cancelInvitation(tx, rc, id);
    switch (result.status) {
      case 'cancelled':
        return jsonOk({ data: { cancelled: true } });
      case 'forbidden':
        return jsonError(403, '只有組織管理員能撤銷邀請');
      case 'not_found':
        return jsonError(404, '邀請不存在');
    }
  });
}
