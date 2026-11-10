// 合約的動作：讀取、下載已簽 PDF、擬約送簽、生命週期，以及還沒歸屬案件的合約。
import {
  ALL_ROLES,
  ALL_STATES,
  WRITE_ROLES,
  type ActionRule,
  type CaseActionRule,
} from './rules';
import type { CaseState } from '../../cases';

/**
 * 合約生命週期動作：與擬約送簽同一批人（主辦組織的 admin、staff，租賃自管、包租與轉租案件的出租人），
 * 差別只在允許的案件狀態。送簽後撤回或拒簽，案件回 `draft`（cases README），所以複製為新草稿在 `draft`。
 * 代管案件的屋主不在內（P0-09：代管案件的屋主不得擬約與送簽）。
 */
function contractLifecycle(states: readonly CaseState[]): CaseActionRule {
  return {
    scope: 'case',
    effect: 'write',
    states,
    hostRoles: {
      lease_self_managed: WRITE_ROLES,
      master_lease: WRITE_ROLES,
      lease_managed: WRITE_ROLES,
      sublease: WRITE_ROLES,
      management: WRITE_ROLES,
    },
    relations: { lease_self_managed: ['lessor'], master_lease: ['lessor'], sublease: ['lessor'] },
    onBehalfScope: null,
    uncased: 'uncased_contract.write',
  };
}

const CONTRACT_LIFECYCLE = {
  // 甲方撤回簽署中的合約。
  'contract.void': contractLifecycle(['signing']),
  // 撤回或拒簽後複製為新草稿，新草稿留在同一案件（P0-09 AC7）。
  'contract.copy': contractLifecycle(['draft']),
  // 重寄簽署通知給當前待簽方。
  'contract.resend': contractLifecycle(['signing']),
  // 向簽署服務商現查當前簽署人的連結。連結能代簽，視同寫入，唯讀角色不得取得。
  'contract.sign_link': contractLifecycle(['signing']),
  // 手動補抓簽署文件。完成當下保存失敗時的補救（簽署中與剛生效的案件）。
  'contract.refetch_files': contractLifecycle(['signing', 'active']),
  // 僅 mock 模式：模擬簽署服務商事件推進狀態。
  'contract.simulate_signing': contractLifecycle(['signing']),
} as const satisfies Record<string, CaseActionRule>;

export const contractActions = {
  // 讀合約：轉租案件的所有權人讀不到（P0-09 AC5）。經紀業者只得讀合約（ADR-0016 決議 14）。
  'contract.read': {
    scope: 'case',
    effect: 'read',
    states: ALL_STATES,
    hostRoles: {
      lease_self_managed: ALL_ROLES,
      master_lease: ALL_ROLES,
      lease_managed: ALL_ROLES,
      sublease: ALL_ROLES,
      management: ALL_ROLES,
    },
    relations: {
      lease_self_managed: ['lessor', 'lessee', 'co_lessee', 'practitioner', 'broker'],
      master_lease: ['lessor', 'lessee', 'co_lessee', 'practitioner', 'broker'],
      lease_managed: ['lessor', 'lessee', 'co_lessee', 'practitioner', 'broker'],
      sublease: ['lessor', 'lessee', 'co_lessee', 'practitioner', 'broker'],
      management: ['mandator', 'mandatary', 'practitioner'],
    },
    onBehalfScope: null,
    uncased: 'uncased_contract.read',
  },
  // 下載已簽合約 PDF（MIL-121）：與讀合約同一批人，結案後仍可（終態只允許讀取，P0-09 AC6）。
  // 獨立成一列，是因為 Audit Trail File 這類檔案之後得以不同的關係開放。
  'contract.download_signed': {
    scope: 'case',
    effect: 'read',
    states: ALL_STATES,
    hostRoles: {
      lease_self_managed: ALL_ROLES,
      master_lease: ALL_ROLES,
      lease_managed: ALL_ROLES,
      sublease: ALL_ROLES,
      management: ALL_ROLES,
    },
    relations: {
      lease_self_managed: ['lessor', 'lessee', 'co_lessee', 'practitioner', 'broker'],
      master_lease: ['lessor', 'lessee', 'co_lessee', 'practitioner', 'broker'],
      lease_managed: ['lessor', 'lessee', 'co_lessee', 'practitioner', 'broker'],
      sublease: ['lessor', 'lessee', 'co_lessee', 'practitioner', 'broker'],
      management: ['mandator', 'mandatary', 'practitioner'],
    },
    onBehalfScope: null,
  },
  // 擬約與送簽：代管業者是，代管案件的屋主否。送簽前提由 checkSendPreconditions 檢查。
  'contract.draft_send': {
    scope: 'case',
    effect: 'write',
    states: ['draft'],
    hostRoles: {
      lease_self_managed: WRITE_ROLES,
      master_lease: WRITE_ROLES,
      lease_managed: WRITE_ROLES,
      sublease: WRITE_ROLES,
      management: WRITE_ROLES,
    },
    relations: { lease_self_managed: ['lessor'], master_lease: ['lessor'], sublease: ['lessor'] },
    onBehalfScope: null,
    uncased: 'uncased_contract.write',
  },
  ...CONTRACT_LIFECYCLE,
  // 還沒歸屬案件的合約（MIL-115 遷移前）：依組織角色。案件動作的 `uncased` 欄位指向這兩列。
  'uncased_contract.read': { scope: 'org', effect: 'read', orgRoles: ALL_ROLES },
  'uncased_contract.write': { scope: 'org', effect: 'write', orgRoles: WRITE_ROLES },
} as const satisfies Record<string, ActionRule>;
