import { whoAmI } from './auth/whoami';
import { requestContext } from './current-request-context';
import { Unauthenticated } from './request-context';

// 目前請求的承租人身分（MIL-121），給 /tenant 的 layout 與頁面用。
// 只有 party 脈絡才有；組織與營運者脈絡、沒有登入都回傳 null，頁面顯示「沒有承租人身分」。

export interface TenantSession {
  partyId: string;
  displayName: string;
}

export async function currentTenantSession(): Promise<TenantSession | null> {
  let rc;
  try {
    rc = await requestContext();
  } catch (error) {
    if (error instanceof Unauthenticated) return null;
    throw error;
  }
  if (rc.kind !== 'party') return null;
  const { displayName } = await whoAmI(rc);
  return { partyId: rc.partyId, displayName };
}
