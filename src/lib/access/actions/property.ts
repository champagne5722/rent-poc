// 物件的動作：讀取與管理。
import { ALL_ROLES, WRITE_ROLES, type ActionRule } from './rules';

export const propertyActions = {
  // 物件在組織層，沒有案件：讀取所有角色，寫入 admin 與 staff，viewer 被拒。
  'property.read': { scope: 'org', effect: 'read', orgRoles: ALL_ROLES },
  'property.manage': { scope: 'org', effect: 'write', orgRoles: WRITE_ROLES },
} as const satisfies Record<string, ActionRule>;
