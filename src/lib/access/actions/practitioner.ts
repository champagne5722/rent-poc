// 執業人員的動作：證書、任職。
import { ALL_ROLES, WRITE_ROLES, type ActionRule } from './rules';

export const practitionerActions = {
  // 執業人員證書與任職（MIL-111）。看自己的證書與任職清單所有角色。登錄、補件、建立任職、送同意書是寫入，
  // admin 與 staff，viewer 被拒（動作表對寫入一律拒絕 viewer）。「只能操作自己的證書」不靠這張表，
  // 由資料庫函式保證（app.party_id 加成員資格）。組織型態必須是 practice 由呼叫端另外檢查。
  'practitioner.read': { scope: 'org', effect: 'read', orgRoles: ALL_ROLES },
  'practitioner.register': { scope: 'org', effect: 'write', orgRoles: WRITE_ROLES },
  // 結束任職：任職本人或執業主體的 admin。這張表放行 admin 與 staff，更細的「本人或 admin」由 registry.end_employment 檢查。
  'employment.end': { scope: 'org', effect: 'write', orgRoles: WRITE_ROLES },
} as const satisfies Record<string, ActionRule>;
