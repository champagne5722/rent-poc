import type { OrgRole } from '../request-context';

// 執業主體端的權限（MIL-109）。先照 MIL-106 的做法檢查身分與組織角色，不經 authorize()。
// MIL-108 的動作表之後可加一列 practice_license.submit（組織層，write，admin 與 staff），
// 屆時只要把 applicantMayWrite 換成 decideAccess 的呼叫，呼叫端不用動。

/** 送件、補件是寫入：只有 practice 組織的 admin 與 staff。viewer 只能看。 */
export function applicantMayWrite(actor: { orgKind: 'owner' | 'practice' | 'platform'; role: OrgRole }): boolean {
  return actor.orgKind === 'practice' && (actor.role === 'admin' || actor.role === 'staff');
}

/** 看進度：practice 組織的所有角色。 */
export function applicantMayRead(actor: { orgKind: 'owner' | 'practice' | 'platform' }): boolean {
  return actor.orgKind === 'practice';
}
