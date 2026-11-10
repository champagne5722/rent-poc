// 點交與退租的動作：確認點交、發起退租、押金扣抵異議。
import { WRITE_ROLES, type ActionRule } from './rules';

export const moveOutActions = {
  // 確認點交：P0-09 表寫代管業者「是」，ADR-0023 決議 7 列為點交範圍的代操作，以 ADR 為準。
  'inspection.confirm': {
    scope: 'case',
    effect: 'write',
    states: ['active', 'move_out'],
    hostRoles: { lease_self_managed: WRITE_ROLES, master_lease: WRITE_ROLES, lease_managed: WRITE_ROLES, sublease: WRITE_ROLES },
    relations: {
      lease_self_managed: ['lessor', 'lessee', 'co_lessee'],
      master_lease: ['lessor', 'lessee', 'co_lessee'],
      lease_managed: ['lessor', 'lessee', 'co_lessee'],
      sublease: ['lessor', 'lessee', 'co_lessee'],
    },
    onBehalfScope: 'inspection',
  },
  // 發起退租：承租人無此權限（ADR-0016 決議 7）。代管業者限委託範圍點交（ADR-0023 決議 7）。
  'move_out.start': {
    scope: 'case',
    effect: 'write',
    states: ['active'],
    hostRoles: { lease_self_managed: WRITE_ROLES, master_lease: WRITE_ROLES, lease_managed: WRITE_ROLES, sublease: WRITE_ROLES },
    relations: { lease_self_managed: ['lessor'], master_lease: ['lessor'], lease_managed: ['lessor'], sublease: ['lessor'] },
    onBehalfScope: 'inspection',
  },
  // 對押金扣抵標示異議：只有承租人與共同承租人。
  'deposit.dispute': {
    scope: 'case',
    effect: 'write',
    states: ['move_out', 'settling'],
    hostRoles: {},
    relations: {
      lease_self_managed: ['lessee', 'co_lessee'],
      master_lease: ['lessee', 'co_lessee'],
      lease_managed: ['lessee', 'co_lessee'],
      sublease: ['lessee', 'co_lessee'],
    },
    onBehalfScope: null,
  },
} as const satisfies Record<string, ActionRule>;
