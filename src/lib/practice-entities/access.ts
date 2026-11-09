import type { OrgRole } from '../request-context';

// 執業主體端的權限（MIL-109）。組織角色由 route 的 authorize() 檢查：動作 practice_registry.read、
// practice_registry.submit、practice_entity.lookup（src/lib/access/actions.ts）。
// 動作表只看組織角色，所以「必須是 practice 組織」在這裡另外檢查。applicantMayWrite 同時保留角色檢查，
// 讓 submitLicenseFlow 在 route 以外被呼叫時也不會放行 viewer（深度防禦，不取代 authorize）。

/** 送件、補件是寫入：只有 practice 組織的 admin 與 staff。viewer 只能看。 */
export function applicantMayWrite(actor: { orgKind: 'owner' | 'practice' | 'platform'; role: OrgRole }): boolean {
  return actor.orgKind === 'practice' && (actor.role === 'admin' || actor.role === 'staff');
}

/** 看進度：practice 組織的所有角色。 */
export function applicantMayRead(actor: { orgKind: 'owner' | 'practice' | 'platform' }): boolean {
  return actor.orgKind === 'practice';
}
