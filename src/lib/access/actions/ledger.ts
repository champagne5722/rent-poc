// 帳務與屋主報表的動作：讀帳務、屋主報表、入帳確認、逾期提醒、押金分錄。
import { ALL_ROLES, ALL_STATES, OPERATING, WRITE_ROLES, type ActionRule } from './rules';

export const ledgerActions = {
  // 讀帳務：不含經紀業者、簽章人員、所有權人。
  'ledger.read': {
    scope: 'case',
    effect: 'read',
    states: ALL_STATES,
    hostRoles: { self_managed: ALL_ROLES, managed: ALL_ROLES, master_lease: ALL_ROLES },
    relations: {
      self_managed: ['lessor', 'lessee', 'co_lessee'],
      managed: ['lessor', 'lessee', 'co_lessee'],
      master_lease: ['lessor', 'lessee', 'co_lessee'],
    },
    onBehalfScope: null,
  },
  // 讀屋主報表：自己的、自己產出的。包租業者否。物件層級的歸屬過濾由 authorize() 查詢。
  'report.read_owner': {
    scope: 'case',
    effect: 'read',
    states: ALL_STATES,
    hostRoles: { self_managed: ALL_ROLES, managed: ALL_ROLES },
    relations: {
      self_managed: ['lessor'],
      managed: ['lessor'],
      master_lease: ['owner'],
    },
    onBehalfScope: null,
  },
  // 登錄入帳確認：代管業者限委託範圍收租。
  'ledger.record_payment': {
    scope: 'case',
    effect: 'write',
    states: OPERATING,
    hostRoles: { self_managed: WRITE_ROLES, managed: WRITE_ROLES, master_lease: WRITE_ROLES },
    relations: { self_managed: ['lessor'], master_lease: ['lessor'] },
    onBehalfScope: 'rent_collection',
  },
  // 逾期提醒（MIL-42 手動按鈕）：ADR-0023 決議 7 列為收租範圍的代操作，P0-09 表沒有這一列。
  'ledger.send_overdue_reminder': {
    scope: 'case',
    effect: 'write',
    states: OPERATING,
    hostRoles: { self_managed: WRITE_ROLES, managed: WRITE_ROLES, master_lease: WRITE_ROLES },
    relations: { self_managed: ['lessor'], master_lease: ['lessor'] },
    onBehalfScope: 'rent_collection',
  },
  // 登錄押金分錄：代管業者限委託範圍押金管理（P0-09 AC4）。
  'ledger.record_deposit': {
    scope: 'case',
    effect: 'write',
    states: OPERATING,
    hostRoles: { self_managed: WRITE_ROLES, managed: WRITE_ROLES, master_lease: WRITE_ROLES },
    relations: { self_managed: ['lessor'], master_lease: ['lessor'] },
    onBehalfScope: 'deposit_management',
  },
} as const satisfies Record<string, ActionRule>;
