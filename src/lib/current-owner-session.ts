import { whoAmI } from './auth/whoami';
import { requestContext } from './current-request-context';
import { ownerSessionFromContext, type OwnerSession } from './owner-session';
import { Unauthenticated } from './request-context';

/**
 * 目前請求的屋主身分，沒有屋主身分時回傳 null。只給 server component 與 route 用。
 * MIL-103 起讀 requestContext()：org 脈絡且 orgKind 是 owner 時才有，其他情況（含沒有登入）回傳 null。
 * 回傳形狀與呼叫端不變（MIL-94）。
 */
export async function currentOwnerSession(): Promise<OwnerSession | null> {
  let rc;
  try {
    rc = await requestContext();
  } catch (error) {
    if (error instanceof Unauthenticated) return null;
    throw error;
  }
  if (rc.kind !== 'org' || rc.orgKind !== 'owner') return null;
  const { displayName } = await whoAmI(rc);
  return ownerSessionFromContext(rc, displayName);
}
