// 收款帳戶的動作：讀取與管理。
import { ALL_ROLES, WRITE_ROLES, type ActionRule } from './rules';

export const paymentAccountActions = {
  // 收款帳戶（MIL-118，E 線）：組織層，沒有案件。看帳戶清單所有角色，登錄、改名與停用 admin 與 staff，viewer 被拒。
  'payment_account.read': { scope: 'org', effect: 'read', orgRoles: ALL_ROLES },
  'payment_account.manage': { scope: 'org', effect: 'write', orgRoles: WRITE_ROLES },
} as const satisfies Record<string, ActionRule>;
