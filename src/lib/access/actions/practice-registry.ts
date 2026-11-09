// 執業主體的動作：登錄進度、送件與補件、批次查詢。
import { ALL_ROLES, WRITE_ROLES, type ActionRule } from './rules';

export const practiceRegistryActions = {
  // 執業主體端（MIL-109）：看自己的登錄進度，所有角色。送件與補件是寫入，admin 與 staff，viewer 被拒。
  // 組織型態必須是 practice 由呼叫端另外檢查，動作表只看組織角色。審核台不走這裡：它靠平台營運者身分，不是組織角色。
  'practice_registry.read': { scope: 'org', effect: 'read', orgRoles: ALL_ROLES },
  'practice_registry.submit': { scope: 'org', effect: 'write', orgRoles: WRITE_ROLES },
  // 執業主體批次查詢（F 線資產總覽，MIL-94）：任何組織成員，只回名稱、稱謂與驗證狀態。
  'practice_entity.lookup': { scope: 'org', effect: 'read', orgRoles: ALL_ROLES },
} as const satisfies Record<string, ActionRule>;
