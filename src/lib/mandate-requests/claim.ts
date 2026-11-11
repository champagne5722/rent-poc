import { defaultIdentityFacts, listIdentityOptions } from '../auth/account-service';
import { loadLiveSession, resolveRequestContext } from '../auth/login-flow';
import { createOwnerOrg } from '../orgs/onboarding';
import { withTx } from '../pg/database';
import { Unauthenticated, type RequestContext } from '../request-context';
import { getLinkView } from './repository';

// 屋主第一次打開連結後的準備（MIL-206 驗收 7）：確認帳號的身分，必要時建立屋主的組織。
// 屋主用既有的 email 驗證碼流程登入。登入後帳號可能是：
//   1. 還沒有任何身分（第一次使用）：連結有效時，用 body 的屋主名稱建屋主組織，session 切到新組織。
//   2. 已經是屋主組織的成員：直接用。
//   3. 屬於業者或平台等其他組織，或有多個身分還沒選：拒絕，訊息固定。業者的員工不能用業者的帳號當屋主。
// 先確認連結有效才建組織，避免無效連結也替人建出空的組織。
// 這裡不寫入申請。綁定由資料庫函式 registry.claim_mandate_request 執行，route 在組織交易內呼叫。

export type PrepareClaimResult =
  | { status: 'ready'; rc: Extract<RequestContext, { kind: 'org' }>; createdOrg: boolean }
  | { status: 'unauthenticated' | 'unavailable' | 'identity_not_chosen' | 'not_owner' | 'name_required' }
  | { status: 'invalid_name'; message: string };

export async function prepareClaim(token: string | undefined, code: string, rawName: unknown, now: Date): Promise<PrepareClaimResult> {
  const session = await loadLiveSession(token, now);
  if (!session) return { status: 'unauthenticated' };

  let createdOrg = false;
  if (!session.identity) {
    const options = await withTx({ kind: 'control' }, (tx) => listIdentityOptions(tx, session, defaultIdentityFacts));
    if (options.length > 0) return { status: 'identity_not_chosen' };
    // 沒有身分的帳號：連結有效才建組織
    if (!(await withTx({ kind: 'control' }, (tx) => getLinkView(tx, code, now)))) return { status: 'unavailable' };
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (name === '') return { status: 'name_required' };
    const created = await createOwnerOrg(token, { name }, { now });
    if (created.status === 'unauthenticated') return { status: 'unauthenticated' };
    if (created.status === 'invalid') return { status: 'invalid_name', message: created.message };
    // has_identity：兩個請求同時建組織，另一個先建好了，繼續往下用它
    createdOrg = created.status === 'ok';
  }

  let rc: RequestContext;
  try {
    rc = await resolveRequestContext(token, now, crypto.randomUUID());
  } catch (error) {
    if (error instanceof Unauthenticated) return { status: 'unauthenticated' };
    throw error;
  }
  if (rc.kind !== 'org' || rc.orgKind !== 'owner') return { status: 'not_owner' };
  return { status: 'ready', rc, createdOrg };
}
