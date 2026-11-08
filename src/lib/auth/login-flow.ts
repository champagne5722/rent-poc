import { withTx } from '../pg/database';
import type { Mailer } from '../mailer';
import { Unauthenticated, type RequestContext } from '../request-context';
import { defaultIdentityFacts, listIdentities, provisionAccount, type IdentityFacts, type SessionIdentity } from './account-service';
import { AUTH_CONFIG, type AuthConfig } from './config';
import { normalizeEmail } from './email';
import { checkOtp, discardOtp, issueOtp } from './otp-service';
import {
  auditContextFor,
  dropExpiredSession,
  findSession,
  openSession,
  recheckMembership,
  removeSession,
} from './session-service';

// 登入、登出與每個請求的身分解析。route 與 requestContext() 只呼叫這裡（MIL-103）。
// 每個函式自己開交易。寄信是外部呼叫，一律在交易提交之後。

export interface LoginDeps {
  now: Date;
  /** 驗證碼雜湊的金鑰，見 resolveAuthSecret。 */
  secret: string;
  mailer: Mailer;
  /** 讀 SEED_OWNER_EMAIL、PLATFORM_OPERATOR_EMAILS。 */
  env: Readonly<Record<string, string | undefined>>;
  config?: AuthConfig;
  facts?: IdentityFacts;
}

export type RequestCodeResult =
  | { status: 'invalid_email' }
  | { status: 'rate_limited'; retryAfterSec: number }
  /** 不論 email 有沒有帳號，成功都是這個結果（P0-21 AC6 的同一原則）。 */
  | { status: 'sent' };

export async function requestLoginCode(rawEmail: unknown, deps: LoginDeps): Promise<RequestCodeResult> {
  const email = normalizeEmail(rawEmail);
  if (!email) return { status: 'invalid_email' };
  const config = deps.config ?? AUTH_CONFIG;

  const issued = await withTx({ kind: 'control' }, (tx) => issueOtp(tx, { email, now: deps.now, secret: deps.secret }, config));
  if (issued.status === 'rate_limited') return issued;

  try {
    await deps.mailer.send({
      to: email,
      subject: '登入驗證碼',
      text: `您的登入驗證碼是 ${issued.code}。${Math.round(config.otpTtlMs / 60_000)} 分鐘內有效，請勿轉告他人。`,
      kind: 'auth.otp',
    });
  } catch (error) {
    // 沒寄出去的驗證碼不該佔著頻率限制
    await withTx({ kind: 'control' }, (tx) => discardOtp(tx, issued.otpId)).catch(() => undefined);
    throw error;
  }
  return { status: 'sent' };
}

export type CompleteLoginResult =
  | { status: 'invalid_code' }
  | { status: 'ok'; token: string; expiresAt: Date; identity: SessionIdentity };

const CODE_PATTERN = /^\d+$/;

export async function completeLogin(rawEmail: unknown, rawCode: unknown, deps: LoginDeps): Promise<CompleteLoginResult> {
  const email = normalizeEmail(rawEmail);
  const config = deps.config ?? AUTH_CONFIG;
  // 格式不對的輸入不算一次嘗試，也不查資料庫；回應與驗證碼錯誤相同
  if (!email || typeof rawCode !== 'string' || rawCode.length !== config.otpLength || !CODE_PATTERN.test(rawCode)) {
    return { status: 'invalid_code' };
  }
  const code = rawCode;

  // 第一個交易：驗證碼與帳號。驗證碼錯誤也要提交，錯誤次數才存得下來，所以失敗用回傳值，不丟例外
  const prepared = await withTx({ kind: 'control' }, async (tx) => {
    const checked = await checkOtp(tx, { email, code, now: deps.now, secret: deps.secret }, config);
    if (!checked.ok) return null;
    const account = await provisionAccount(tx, { email, now: deps.now, env: deps.env });
    const identities = await listIdentities(tx, account, deps.facts ?? defaultIdentityFacts);
    return { account, identity: identities[0] ?? null };
  });
  if (!prepared) return { status: 'invalid_code' };

  // 第二個交易：session 與登入事件，開在事件要進的那條鏈的脈絡
  const { account, identity } = prepared;
  const opened = await withTx(auditContextFor(identity, account.partyId), (tx) =>
    openSession(tx, { userId: account.userId, partyId: account.partyId, identity, now: deps.now }, config),
  );
  return { status: 'ok', token: opened.token, expiresAt: opened.expiresAt, identity };
}

/** 登出：刪除 session 列並寫事件。token 查不到時什麼都不做（登出是冪等的）。 */
export async function logout(token: string): Promise<void> {
  const session = await withTx({ kind: 'control' }, (tx) => findSession(tx, token));
  if (!session) return;
  await withTx(auditContextFor(session.identity, session.partyId), (tx) => removeSession(tx, session, 'auth.logout'));
}

/**
 * 每個請求的身分解析（ADR-0022 決議 2、7）：查 session，並重新查目前身分的成員資格。
 * 沒有 session、已到期、沒有身分都丟 Unauthenticated。成員資格已失效時，刪除 session、寫稽核事件，再丟 Unauthenticated。
 */
export async function resolveRequestContext(
  token: string | undefined,
  now: Date,
  requestId: string,
  facts: IdentityFacts = defaultIdentityFacts,
): Promise<RequestContext> {
  if (!token) throw new Unauthenticated(undefined, 'no_session');

  const checked = await withTx({ kind: 'control' }, async (tx) => {
    const session = await findSession(tx, token);
    if (!session) return { state: 'missing' as const };
    if (session.expiresAt.getTime() <= now.getTime()) {
      await dropExpiredSession(tx, session.sessionId);
      return { state: 'expired' as const };
    }
    if (!session.identity) return { state: 'no_identity' as const };
    const membership = await recheckMembership(tx, session, facts);
    return membership ? { state: 'ok' as const, session, membership } : { state: 'lost' as const, session };
  });

  switch (checked.state) {
    case 'missing':
      throw new Unauthenticated(undefined, 'no_session');
    case 'expired':
      throw new Unauthenticated(undefined, 'expired');
    case 'no_identity':
      throw new Unauthenticated(undefined, 'no_identity');
    case 'lost': {
      const { session } = checked;
      await withTx(auditContextFor(session.identity, session.partyId), (tx) =>
        removeSession(tx, session, 'auth.membership_rejected'),
      );
      throw new Unauthenticated(undefined, 'membership_lost');
    }
    case 'ok': {
      const { session, membership } = checked;
      const base = { userId: session.userId, partyId: session.partyId, requestId };
      if (membership.kind === 'org' && session.identity?.kind === 'org') {
        return { kind: 'org', orgId: session.identity.orgId, orgKind: membership.orgKind, role: membership.role, ...base };
      }
      // org 以外的身分沒有組織欄位。org 身分一定走上面那一支，recheckMembership 保證兩者同時成立
      if (membership.kind === 'org') throw new Error('成員資格與 session 身分不一致');
      return { kind: membership.kind, ...base };
    }
  }
}
