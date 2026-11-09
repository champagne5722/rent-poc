// 站內通知的動作：讀取、標已讀、demo 送測試通知。
import { ALL_ROLES, WRITE_ROLES, type ActionRule } from './rules';

export const notificationActions = {
  // 站內通知（MIL-120，E 線）：看自己的通知與標已讀，所有角色。標已讀只改自己的已讀狀態，
  // 不改組織資料，所以 effect 是 read，viewer 也能標。可見範圍（個人通知、組織通知）由通知模組依 partyId 篩選。
  'notification.read': { scope: 'org', effect: 'read', orgRoles: ALL_ROLES },
  'notification.mark_read': { scope: 'org', effect: 'read', orgRoles: ALL_ROLES },
  // demo 送測試通知（MIL-120）：寫入通知與 email 列，admin 與 staff。route 另外只在 Mock 寄信模式存在。
  'notification.demo_send': { scope: 'org', effect: 'write', orgRoles: WRITE_ROLES },
} as const satisfies Record<string, ActionRule>;
