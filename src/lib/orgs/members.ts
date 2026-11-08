import { decideAccess } from '../access';
import { appendAudit } from '../audit';
import { normalizeEmail } from '../auth/email';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import type { OrgRole } from '../request-context';

// 組織成員管理（MIL-106，ADR-0022 決議 5）：列表、邀請、改角色、移除、撤銷邀請。
// 都在目前組織的 org 脈絡內呼叫。control 的表不掛 RLS，所以每個查詢都明確帶 org_id，不靠脈絡。
// 只有 admin 能管理成員，判斷交給 decideAccess 的 org_member.manage（MIL-108 的動作表）。
// 稽核事件寫在這個組織自己的鏈（ADR-0019 決議 2），payload 不放 email 與姓名。

export interface Actor {
  orgId: string;
  userId: string;
  role: OrgRole;
}

export const ROLE_VALUES: readonly OrgRole[] = ['admin', 'staff', 'viewer'];

export function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === 'string' && (ROLE_VALUES as readonly string[]).includes(value);
}

function mayManage(actor: Actor): boolean {
  return decideAccess({ orgRole: actor.role, caseFacts: null }, 'org_member.manage').allowed;
}

export interface MemberRow {
  userId: string;
  email: string;
  displayName: string;
  role: OrgRole;
  joinedAt: string;
}

export interface InvitationRow {
  id: string;
  email: string;
  role: OrgRole;
  invitedAt: string;
}

export interface MemberList {
  members: MemberRow[];
  /** 待處理的邀請。只有 admin 看得到，其他角色是空陣列。 */
  invitations: InvitationRow[];
}

const iso = (value: Date | string): string => new Date(value).toISOString();

export async function listMembers(tx: OrgTx, actor: Actor): Promise<MemberList> {
  const members = await tx.query<{ user_id: string; email: string; display_name: string; role: OrgRole; created_at: Date | string }>(
    `SELECT m.user_id, p.email, p.display_name, m.role, m.created_at
       FROM control.org_memberships m
       JOIN control.users u ON u.id = m.user_id
       JOIN control.parties p ON p.id = u.party_id
      WHERE m.org_id = $1 ORDER BY m.created_at, m.id`,
    [actor.orgId],
  );
  const invitations = mayManage(actor)
    ? await tx.query<{ id: string; email: string; role: OrgRole; created_at: Date | string }>(
        `SELECT id, email, role, created_at FROM control.org_invitations
          WHERE org_id = $1 AND accepted_at IS NULL ORDER BY created_at, id`,
        [actor.orgId],
      )
    : { rows: [] };
  return {
    members: members.rows.map((r) => ({
      userId: r.user_id,
      email: r.email,
      displayName: r.display_name,
      role: r.role,
      joinedAt: iso(r.created_at),
    })),
    invitations: invitations.rows.map((r) => ({ id: r.id, email: r.email, role: r.role, invitedAt: iso(r.created_at) })),
  };
}

export type InviteResult =
  | { status: 'invited'; invitationId: string; email: string; orgName: string }
  | { status: 'forbidden' }
  | { status: 'invalid_email' }
  | { status: 'invalid_role' }
  | { status: 'already_member' }
  | { status: 'already_invited' };

export async function inviteMember(
  tx: OrgTx,
  actor: Actor,
  input: { email: unknown; role: unknown; now: Date },
): Promise<InviteResult> {
  if (!mayManage(actor)) return { status: 'forbidden' };
  const email = normalizeEmail(input.email);
  if (!email) return { status: 'invalid_email' };
  if (!isOrgRole(input.role)) return { status: 'invalid_role' };

  const member = await tx.query(
    `SELECT 1 FROM control.org_memberships m
       JOIN control.users u ON u.id = m.user_id JOIN control.parties p ON p.id = u.party_id
      WHERE m.org_id = $1 AND p.email = $2`,
    [actor.orgId, email],
  );
  if (member.rows.length > 0) return { status: 'already_member' };

  const id = newUlid();
  const inserted = await tx.query(
    `INSERT INTO control.org_invitations (id, org_id, email, role, invited_by_user_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (org_id, email) WHERE accepted_at IS NULL DO NOTHING RETURNING id`,
    [id, actor.orgId, email, input.role, actor.userId, input.now.toISOString()],
  );
  if (inserted.rows.length === 0) return { status: 'already_invited' };

  await appendAudit(tx, { action: 'member.invite', object: { type: 'invitation', id }, payload: { role: input.role } });
  const org = await tx.query<{ name: string }>('SELECT name FROM control.orgs WHERE id = $1', [actor.orgId]);
  return { status: 'invited', invitationId: id, email, orgName: org.rows[0].name };
}

export type CancelInvitationResult = { status: 'cancelled' } | { status: 'forbidden' } | { status: 'not_found' };

export async function cancelInvitation(tx: OrgTx, actor: Actor, invitationId: string): Promise<CancelInvitationResult> {
  if (!mayManage(actor)) return { status: 'forbidden' };
  const deleted = await tx.query(
    'DELETE FROM control.org_invitations WHERE id = $1 AND org_id = $2 AND accepted_at IS NULL RETURNING id',
    [invitationId, actor.orgId],
  );
  if (deleted.rows.length === 0) return { status: 'not_found' };
  await appendAudit(tx, { action: 'member.invite_cancel', object: { type: 'invitation', id: invitationId } });
  return { status: 'cancelled' };
}

export type ChangeRoleResult =
  | { status: 'changed' }
  | { status: 'unchanged' }
  | { status: 'forbidden' }
  | { status: 'invalid_role' }
  | { status: 'not_found' }
  /** 組織至少要留一位 admin。 */
  | { status: 'last_admin' };

/** 鎖住這個組織所有 admin 的列再數，兩個 admin 同時互相降級時，第二個會等第一個提交後看到只剩一位。 */
async function lockAdmins(tx: OrgTx, orgId: string): Promise<string[]> {
  const { rows } = await tx.query<{ user_id: string }>(
    `SELECT user_id FROM control.org_memberships WHERE org_id = $1 AND role = 'admin' ORDER BY id FOR UPDATE`,
    [orgId],
  );
  return rows.map((r) => r.user_id);
}

export async function changeRole(tx: OrgTx, actor: Actor, input: { userId: string; role: unknown }): Promise<ChangeRoleResult> {
  if (!mayManage(actor)) return { status: 'forbidden' };
  if (!isOrgRole(input.role)) return { status: 'invalid_role' };

  const admins = await lockAdmins(tx, actor.orgId);
  const target = await tx.query<{ id: string; role: OrgRole }>(
    'SELECT id, role FROM control.org_memberships WHERE org_id = $1 AND user_id = $2',
    [actor.orgId, input.userId],
  );
  const row = target.rows[0];
  if (!row) return { status: 'not_found' };
  if (row.role === input.role) return { status: 'unchanged' };
  if (row.role === 'admin' && admins.length <= 1) return { status: 'last_admin' };

  await tx.query('UPDATE control.org_memberships SET role = $1 WHERE id = $2', [input.role, row.id]);
  await appendAudit(tx, {
    action: 'member.role_change',
    object: { type: 'membership', id: row.id },
    payload: { from: row.role, to: input.role },
  });
  return { status: 'changed' };
}

export type RemoveMemberResult =
  | { status: 'removed'; sessionsRevoked: number }
  | { status: 'forbidden' }
  | { status: 'not_found' }
  | { status: 'last_admin' };

/**
 * 移除成員。同一個交易刪除該帳號以這個組織為身分的 session（P0-02 AC6），所以對方的下一個請求拿不到 session，被拒絕。
 * 該帳號其他身分的 session 不動。稽核事件是 member.revoke，在這個組織的鏈。
 */
export async function removeMember(tx: OrgTx, actor: Actor, input: { userId: string }): Promise<RemoveMemberResult> {
  if (!mayManage(actor)) return { status: 'forbidden' };

  const admins = await lockAdmins(tx, actor.orgId);
  const target = await tx.query<{ id: string; role: OrgRole }>(
    'SELECT id, role FROM control.org_memberships WHERE org_id = $1 AND user_id = $2',
    [actor.orgId, input.userId],
  );
  const row = target.rows[0];
  if (!row) return { status: 'not_found' };
  if (row.role === 'admin' && admins.length <= 1) return { status: 'last_admin' };

  await tx.query('DELETE FROM control.org_memberships WHERE id = $1', [row.id]);
  const revoked = await tx.query(
    `DELETE FROM control.sessions WHERE user_id = $1 AND identity_kind = 'org' AND identity_org_id = $2 RETURNING id`,
    [input.userId, actor.orgId],
  );
  await appendAudit(tx, {
    action: 'member.revoke',
    object: { type: 'membership', id: row.id },
    payload: { role: row.role, sessions_revoked: revoked.rows.length },
  });
  return { status: 'removed', sessionsRevoked: revoked.rows.length };
}
