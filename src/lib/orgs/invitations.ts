import { appendAudit } from '../audit';
import { newUlid } from '../pg/ulid';
import type { ControlTx, OrgTx } from '../pg/with-tx';
import type { OrgRole } from '../request-context';

// 邀請轉成員（MIL-106，ADR-0022 決議 4）。被邀請者通過驗證碼登入時，login-flow 先在 control 脈絡列出待處理的邀請，
// 再對每一筆開該組織的 org 脈絡接受它，成員資格與 member.grant 事件才會進同一個組織的稽核鏈。

export interface PendingInvitation {
  id: string;
  orgId: string;
  role: OrgRole;
}

/** 這個 email 所有待處理的邀請，先邀請的在前。email 必須已正規化（小寫、去空白）。 */
export async function pendingInvitationsFor(tx: ControlTx, email: string): Promise<PendingInvitation[]> {
  const { rows } = await tx.query<{ id: string; org_id: string; role: OrgRole }>(
    'SELECT id, org_id, role FROM control.org_invitations WHERE email = $1 AND accepted_at IS NULL ORDER BY created_at, id',
    [email],
  );
  return rows.map((r) => ({ id: r.id, orgId: r.org_id, role: r.role }));
}

/**
 * 接受一筆邀請：標記已接受、加成員、寫 member.grant。tx 必須是該邀請的 org 脈絡。
 * 帳號早就是成員時（例如環境變數已補過）只標記已接受，不改角色、不寫事件。
 * 已被別的請求接受的邀請什麼都不做（並發登入）。
 */
export async function acceptInvitation(
  tx: OrgTx,
  input: { invitation: PendingInvitation; userId: string; now: Date },
): Promise<'granted' | 'already_member' | 'gone'> {
  const { invitation, userId, now } = input;
  const accepted = await tx.query(
    `UPDATE control.org_invitations SET accepted_at = $2 WHERE id = $1 AND org_id = $3 AND accepted_at IS NULL RETURNING id`,
    [invitation.id, now.toISOString(), invitation.orgId],
  );
  if (accepted.rows.length === 0) return 'gone';

  const membershipId = newUlid();
  const inserted = await tx.query(
    `INSERT INTO control.org_memberships (id, org_id, user_id, role, created_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (org_id, user_id) DO NOTHING RETURNING id`,
    [membershipId, invitation.orgId, userId, invitation.role, now.toISOString()],
  );
  if (inserted.rows.length === 0) return 'already_member';

  await appendAudit(tx, {
    action: 'member.grant',
    object: { type: 'membership', id: membershipId },
    payload: { role: invitation.role, via: 'invitation', invitation_id: invitation.id },
  });
  return 'granted';
}
