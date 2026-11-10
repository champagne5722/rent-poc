// 帳務與屋主報表的動作：讀帳務、屋主報表、入帳確認、逾期提醒、押金分錄。
import { ALL_ROLES, ALL_STATES, OPEN, OPERATING, WRITE_ROLES, type ActionRule } from './rules';

export const ledgerActions = {
  // 讀帳務：不含經紀業者、簽章人員、所有權人。
  'ledger.read': {
    scope: 'case',
    effect: 'read',
    states: ALL_STATES,
    hostRoles: { lease_self_managed: ALL_ROLES, master_lease: ALL_ROLES, lease_managed: ALL_ROLES, sublease: ALL_ROLES },
    relations: {
      lease_self_managed: ['lessor', 'lessee', 'co_lessee'],
      master_lease: ['lessor', 'lessee', 'co_lessee'],
      lease_managed: ['lessor', 'lessee', 'co_lessee'],
      sublease: ['lessor', 'lessee', 'co_lessee'],
    },
    onBehalfScope: null,
  },
  // 讀屋主報表：自己的、自己產出的。包租業者否。物件層級的歸屬過濾由 authorize() 查詢。
  'report.read_owner': {
    scope: 'case',
    effect: 'read',
    states: ALL_STATES,
    hostRoles: { lease_self_managed: ALL_ROLES, master_lease: ALL_ROLES, lease_managed: ALL_ROLES },
    relations: {
      lease_self_managed: ['lessor'],
      master_lease: ['lessor'],
      lease_managed: ['lessor'],
      sublease: ['owner'],
    },
    onBehalfScope: null,
  },
  // 登錄入帳確認：代管業者限委託範圍收租。
  'ledger.record_payment': {
    scope: 'case',
    effect: 'write',
    states: OPERATING,
    hostRoles: { lease_self_managed: WRITE_ROLES, master_lease: WRITE_ROLES, lease_managed: WRITE_ROLES, sublease: WRITE_ROLES },
    relations: { lease_self_managed: ['lessor'], master_lease: ['lessor'], sublease: ['lessor'] },
    onBehalfScope: 'rent_collection',
  },
  // 逾期提醒（MIL-42 手動按鈕）：ADR-0023 決議 7 列為收租範圍的代操作，P0-09 表沒有這一列。
  'ledger.send_overdue_reminder': {
    scope: 'case',
    effect: 'write',
    states: OPERATING,
    hostRoles: { lease_self_managed: WRITE_ROLES, master_lease: WRITE_ROLES, lease_managed: WRITE_ROLES, sublease: WRITE_ROLES },
    relations: { lease_self_managed: ['lessor'], master_lease: ['lessor'], sublease: ['lessor'] },
    onBehalfScope: 'rent_collection',
  },
  // 登錄押金分錄：代管業者限委託範圍押金管理（P0-09 AC4）。
  'ledger.record_deposit': {
    scope: 'case',
    effect: 'write',
    states: OPERATING,
    hostRoles: { lease_self_managed: WRITE_ROLES, master_lease: WRITE_ROLES, lease_managed: WRITE_ROLES, sublease: WRITE_ROLES },
    relations: { lease_self_managed: ['lessor'], master_lease: ['lessor'], sublease: ['lessor'] },
    onBehalfScope: 'deposit_management',
  },
  // 案件的帳務設定（MIL-123）：匯款識別與預設收款帳戶。草稿案件就能設，結案後唯讀。
  // 不列入代操作：代操作正好是 ADR-0023 決議 7 的六個動作。設定匯款識別是代管業者自己的作業，不代屋主收租。
  'ledger.configure_case': {
    scope: 'case',
    effect: 'write',
    states: OPEN,
    hostRoles: { lease_self_managed: WRITE_ROLES, master_lease: WRITE_ROLES, lease_managed: WRITE_ROLES, sublease: WRITE_ROLES },
    relations: { lease_self_managed: ['lessor'], master_lease: ['lessor'], sublease: ['lessor'] },
    onBehalfScope: null,
  },
  // 讀案件的帳務設定（MIL-123）：押金台帳、應收期別、匯款識別、預設帳戶、社宅旗標修改紀錄。
  // 比 ledger.read 窄：承租人端不顯示應收期別與逾期，匯款識別是付款人個資。
  'ledger.read_case_setup': {
    scope: 'case',
    effect: 'read',
    states: ALL_STATES,
    hostRoles: { lease_self_managed: ALL_ROLES, master_lease: ALL_ROLES, lease_managed: ALL_ROLES, sublease: ALL_ROLES },
    relations: { lease_self_managed: ['lessor'], master_lease: ['lessor'], lease_managed: ['lessor'], sublease: ['lessor'] },
    onBehalfScope: null,
  },
  // 修改社宅代管旗標（ADR-0050 決議 10）：代管與包租案件的主辦組織。自管案件沒有代管業者，旗標不適用。
  'case.set_social_housing': {
    scope: 'case',
    effect: 'write',
    states: OPEN,
    hostRoles: { lease_managed: WRITE_ROLES, sublease: WRITE_ROLES },
    relations: {},
    onBehalfScope: null,
  },
} as const satisfies Record<string, ActionRule>;
