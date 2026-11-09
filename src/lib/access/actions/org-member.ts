// 組織成員的動作：管理與列表。
import { ALL_ROLES, type ActionRule } from './rules';

export const orgMemberActions = {
  // 組織成員管理：只有 admin（P0-02、MIL-100 組織角色）。
  'org_member.manage': { scope: 'org', effect: 'write', orgRoles: ['admin'] },
  // 組織成員列表：所有角色。待處理邀請只給 admin，由載入資料的人過濾。
  'org_member.read': { scope: 'org', effect: 'read', orgRoles: ALL_ROLES },
} as const satisfies Record<string, ActionRule>;
