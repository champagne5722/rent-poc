import { readSessionToken } from '@/lib/auth/cookie';
import { listSessionIdentities } from '@/lib/auth/login-flow';
import { jsonError, jsonOk } from '@/lib/http';

// 切換器的內容（MIL-106）：帳號真的有的身分，加上目前是哪一個。一種身分時畫面不顯示切換器。

export async function GET(request: Request): Promise<Response> {
  const list = await listSessionIdentities(readSessionToken(request.headers.get('cookie')), new Date());
  if (!list) return jsonError(401, '尚未登入或沒有存取權');
  return jsonOk({
    data: {
      current: list.current ? { kind: list.current.kind, label: list.current.label, ...orgIdOf(list.current.identity) } : null,
      options: list.options.map((o) => ({ kind: o.kind, label: o.label, ...orgIdOf(o.identity) })),
    },
  });
}

function orgIdOf(identity: { kind: string; orgId?: string }): { orgId?: string } {
  return identity.kind === 'org' ? { orgId: identity.orgId } : {};
}
