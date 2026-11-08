import { appendAudit, type AuditAction } from '../audit';
import type { DbContext, Tx } from '../pg/with-tx';
import { newUlid } from '../pg/ulid';
import type { OrgKind, OrgRole } from '../request-context';
import { AUTH_CONFIG, type AuthConfig } from './config';
import { hashSessionToken, newSessionToken } from './crypto';
import type { SessionIdentity } from './account-service';

// session 的資料庫操作（control.sessions）與登入、登出、拒絕的稽核事件。
//
// 稽核事件寫在哪條鏈（ADR-0019 決議 2）：
// - 有組織身分：開 org 脈絡，事件進該組織的鏈，組織管理員匯出稽核時看得到成員登入。
// - 承租人、營運者、尚無身分：開 control 脈絡，沒有組織脈絡，事件進平台組織的鏈。
// session 表在 control，不掛組織 RLS，所以 org 脈絡的交易也能寫它，登入與稽核可以同一個交易。
// 行為者一律明確指定為該帳號的 party：登入前的脈絡沒有行為者可取。
// payload 不放個資（canonical 寫入後刪不掉），只放驗證等級與身分種類。

/** 事件要寫進哪條鏈，就開哪種脈絡。 */
export function auditContextFor(identity: SessionIdentity, partyId: string): DbContext {
  return identity?.kind === 'org' ? { kind: 'org', orgId: identity.orgId, partyId } : { kind: 'control' };
}

function identityLabel(identity: SessionIdentity): string {
  return identity?.kind ?? 'none';
}

export interface OpenedSession {
  sessionId: string;
  token: string;
  expiresAt: Date;
}

/** 建立 session 並寫登入事件，同一個交易。tx 必須是 auditContextFor(identity) 開出來的。承租人寫 tenant.login。 */
export async function openSession(
  tx: Tx,
  input: { userId: string; partyId: string; identity: SessionIdentity; now: Date },
  config: AuthConfig = AUTH_CONFIG,
): Promise<OpenedSession> {
  const { userId, partyId, identity, now } = input;
  if ((identity?.kind === 'org') !== (tx.kind === 'org')) {
    throw new Error('openSession 的交易脈絡必須與身分一致：有組織身分用 org 脈絡，其餘用 control 脈絡');
  }
  const sessionId = newUlid();
  const token = newSessionToken();
  const expiresAt = new Date(now.getTime() + config.sessionTtlMs);

  // 順手清掉這個帳號已到期的 session
  await tx.query('DELETE FROM control.sessions WHERE user_id = $1 AND expires_at <= $2', [userId, now.toISOString()]);
  await tx.query(
    `INSERT INTO control.sessions
       (id, token_hash, user_id, identity_kind, identity_org_id, identity_level, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      sessionId,
      hashSessionToken(token),
      userId,
      identity?.kind ?? null,
      identity?.kind === 'org' ? identity.orgId : null,
      config.identityLevel,
      now.toISOString(),
      expiresAt.toISOString(),
    ],
  );
  const action: AuditAction = identity?.kind === 'party' ? 'tenant.login' : 'auth.login';
  await appendAudit(tx, {
    action,
    object: { type: 'session', id: sessionId },
    payload: { actor_identity_level: config.identityLevel, identity: identityLabel(identity) },
    actor: { type: 'party', id: partyId },
  });
  return { sessionId, token, expiresAt };
}

export interface SessionRow {
  sessionId: string;
  userId: string;
  partyId: string;
  identity: SessionIdentity;
  identityLevel: number;
  expiresAt: Date;
}

interface SessionDbRow {
  id: string;
  user_id: string;
  party_id: string;
  identity_kind: 'org' | 'party' | 'operator' | null;
  identity_org_id: string | null;
  identity_level: number;
  expires_at: Date | string;
}

/** 以 cookie 的 token 找 session。找不到回傳 null。 */
export async function findSession(tx: Tx<'control'>, token: string): Promise<SessionRow | null> {
  const { rows } = await tx.query<SessionDbRow>(
    `SELECT s.id, s.user_id, u.party_id, s.identity_kind, s.identity_org_id, s.identity_level, s.expires_at
       FROM control.sessions s JOIN control.users u ON u.id = s.user_id
      WHERE s.token_hash = $1`,
    [hashSessionToken(token)],
  );
  const r = rows[0];
  if (!r) return null;
  const identity: SessionIdentity =
    r.identity_kind === 'org' && r.identity_org_id
      ? { kind: 'org', orgId: r.identity_org_id }
      : r.identity_kind === 'party'
        ? { kind: 'party' }
        : r.identity_kind === 'operator'
          ? { kind: 'operator' }
          : null;
  return {
    sessionId: r.id,
    userId: r.user_id,
    partyId: r.party_id,
    identity,
    identityLevel: r.identity_level,
    expiresAt: new Date(r.expires_at),
  };
}

/** 刪除 session 並寫一筆事件（登出，或成員資格失效被拒絕）。tx 必須是 auditContextFor(session.identity) 開出來的。 */
export async function removeSession(tx: Tx, session: SessionRow, action: 'auth.logout' | 'auth.membership_rejected'): Promise<void> {
  await tx.query('DELETE FROM control.sessions WHERE id = $1', [session.sessionId]);
  await appendAudit(tx, {
    action,
    object: { type: 'session', id: session.sessionId },
    payload: {
      actor_identity_level: session.identityLevel,
      identity: identityLabel(session.identity),
      ...(action === 'auth.membership_rejected' ? { reason: 'membership_removed' } : {}),
    },
    actor: { type: 'party', id: session.partyId },
  });
}

/** 靜默刪除已到期的 session，不寫事件（到期是時間造成的，不是操作）。 */
export async function dropExpiredSession(tx: Tx<'control'>, sessionId: string): Promise<void> {
  await tx.query('DELETE FROM control.sessions WHERE id = $1', [sessionId]);
}

export interface MembershipFacts {
  orgKind?: OrgKind;
  role?: OrgRole;
}

/** 目前身分的成員資格還在不在。回傳 null 代表已失效。在 control 脈絡讀。 */
export async function recheckMembership(
  tx: Tx<'control'>,
  session: SessionRow,
  facts: { partyHasCaseMembership(tx: Tx<'control'>, partyId: string): Promise<boolean> },
): Promise<MembershipFacts | null> {
  const identity = session.identity;
  if (!identity) return null;
  switch (identity.kind) {
    case 'org': {
      const { rows } = await tx.query<{ role: OrgRole; kind: OrgKind }>(
        `SELECT m.role, o.kind FROM control.org_memberships m JOIN control.orgs o ON o.id = m.org_id
          WHERE m.user_id = $1 AND m.org_id = $2`,
        [session.userId, identity.orgId],
      );
      // 平台組織的成員只能以 operator 身分運作，org 身分指到平台組織視同失效
      if (!rows[0] || rows[0].kind === 'platform') return null;
      return { orgKind: rows[0].kind, role: rows[0].role };
    }
    case 'operator': {
      const { rows } = await tx.query(
        `SELECT 1 FROM control.org_memberships m JOIN control.orgs o ON o.id = m.org_id
          WHERE m.user_id = $1 AND o.kind = 'platform'`,
        [session.userId],
      );
      return rows.length > 0 ? {} : null;
    }
    case 'party':
      return (await facts.partyHasCaseMembership(tx, session.partyId)) ? {} : null;
  }
}
