// 案件本身的動作：讀租期與狀態、案件清單、案件成員管理。
import { ALL_ROLES, ALL_STATES, OPEN, WRITE_ROLES, type ActionRule } from './rules';

export const caseActions = {
  // 讀租期與狀態：所有成員，含包租案件的所有權人（P0-09 AC5）。
  'case.read_summary': {
    scope: 'case',
    effect: 'read',
    states: ALL_STATES,
    hostRoles: {
      self_managed: ALL_ROLES,
      managed: ALL_ROLES,
      master_lease: ALL_ROLES,
      management: ALL_ROLES,
    },
    relations: {
      self_managed: ['lessor', 'lessee', 'co_lessee', 'practitioner', 'broker'],
      managed: ['lessor', 'lessee', 'co_lessee', 'practitioner', 'broker'],
      master_lease: ['lessor', 'owner', 'lessee', 'co_lessee', 'practitioner', 'broker'],
      management: ['mandator', 'mandatary', 'practitioner'],
    },
    onBehalfScope: null,
  },
  // 案件成員管理：共同承租人、簽章人員、經紀業者的指派，承租人 email 更新（ADR-0023 決議 5）。
  'case_member.manage': {
    scope: 'case',
    effect: 'write',
    states: OPEN,
    hostRoles: {
      self_managed: WRITE_ROLES,
      managed: WRITE_ROLES,
      master_lease: WRITE_ROLES,
      management: WRITE_ROLES,
    },
    relations: {},
    onBehalfScope: null,
  },
  // 案件清單（MIL-115）：列出目前組織主辦的案件，加上自己是成員的別組織案件。所有角色可讀。
  // 清單內每一列能看到什麼，由 RLS 的成員讀取政策決定；進入單一案件另走 case.read_summary。
  'case.list': { scope: 'org', effect: 'read', orgRoles: ALL_ROLES },
} as const satisfies Record<string, ActionRule>;
