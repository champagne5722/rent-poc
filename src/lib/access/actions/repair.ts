// 修繕的動作：承租人報修、建立與處理修繕紀錄。
import { OPERATING, WRITE_ROLES, type ActionRule } from './rules';

export const repairActions = {
  // 承租人報修：承租人與共同承租人的修繕權限只有報修。
  'repair.report': {
    scope: 'case',
    effect: 'write',
    states: OPERATING,
    hostRoles: {},
    relations: {
      lease_self_managed: ['lessee', 'co_lessee'],
      master_lease: ['lessee', 'co_lessee'],
      lease_managed: ['lessee', 'co_lessee'],
      sublease: ['lessee', 'co_lessee'],
    },
    onBehalfScope: null,
  },
  // 建立與處理修繕紀錄：代管案件的屋主是，代管業者限委託範圍修繕。
  'repair.manage': {
    scope: 'case',
    effect: 'write',
    states: OPERATING,
    hostRoles: { lease_self_managed: WRITE_ROLES, master_lease: WRITE_ROLES, lease_managed: WRITE_ROLES, sublease: WRITE_ROLES },
    relations: { lease_self_managed: ['lessor'], master_lease: ['lessor'], lease_managed: ['lessor'], sublease: ['lessor'] },
    onBehalfScope: 'repair',
  },
} as const satisfies Record<string, ActionRule>;
