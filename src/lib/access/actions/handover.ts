// 移交的動作：發起移交。
import { OPERATING, WRITE_ROLES, type ActionRule } from './rules';

export const handoverActions = {
  // 發起移交：只適用代管租賃案件與它連結的委託管理案件（ADR-0024 決議 1）。
  // 租賃案件由屋主（lessor）或代管業者發起，委託管理案件由委託人、受託人或主辦組織發起。
  'handover.initiate': {
    scope: 'case',
    effect: 'write',
    states: OPERATING,
    hostRoles: { lease_managed: WRITE_ROLES, management: WRITE_ROLES },
    relations: { lease_managed: ['lessor'], management: ['mandator', 'mandatary'] },
    onBehalfScope: null,
  },
} as const satisfies Record<string, ActionRule>;
