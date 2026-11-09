// 稽核紀錄的動作：匯出。
import type { ActionRule } from './rules';

export const auditActions = {
  // 稽核紀錄匯出：只限 admin（P0-23 AC6）。
  'audit.export': { scope: 'org', effect: 'read', orgRoles: ['admin'] },
} as const satisfies Record<string, ActionRule>;
