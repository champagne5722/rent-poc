// 動作表（ADR-0023 決議 6、7，PRD P0-09 權限表）。
// 純常數與型別，沒有 I/O。每列寫允許的組織角色、案件關係、案件狀態，以及是否為代操作。
// E 線加動作時，在 ACTIONS 加一列，並在 decide-access.test.ts 的預期表加對應列。

import {
  LEASE_CASE_STATES,
  MANAGEMENT_CASE_STATES,
  type BusinessType,
  type CaseMemberRelation,
  type CaseState,
} from '../cases';

/** 組織角色（ADR-0022）：管理員、業務人員、唯讀。 */
export const ORG_ROLES = ['admin', 'staff', 'viewer'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** 委託範圍（ADR-0023 決議 7、GLOSSARY）：收租、押金管理、修繕、點交。 */
export const MANDATE_SCOPES = ['rent_collection', 'deposit_management', 'repair', 'inspection'] as const;
export type MandateScope = (typeof MANDATE_SCOPES)[number];

/**
 * 案件變體：租賃案件依業務類型分三種，委託管理案件另算一種。
 * 動作表依變體決定主辦組織與案件關係的意義，例如 `lessor` 關係在代管案件是屋主，在包租案件是包租業者。
 */
export type CaseVariant = BusinessType | 'management';

/** 終態：只允許讀取（ADR-0016 決議 15，P0-09 AC6）。不結束成員的 valid_period。 */
export const TERMINAL_CASE_STATES: readonly CaseState[] = ['closed', 'aborted', 'terminated', 'expired'];

const ALL_STATES: readonly CaseState[] = [...new Set<CaseState>([...LEASE_CASE_STATES, ...MANAGEMENT_CASE_STATES])];
/** 簽約完成後、結案前。入帳、押金、修繕等日常動作用。 */
const OPERATING: readonly CaseState[] = ['active', 'move_out', 'settling'];
/** 非終態。成員管理用。 */
const OPEN: readonly CaseState[] = ['draft', 'signing', 'active', 'move_out', 'settling'];

const ALL_ROLES: readonly OrgRole[] = ['admin', 'staff', 'viewer'];
const WRITE_ROLES: readonly OrgRole[] = ['admin', 'staff'];

/** 組織層動作：不看案件，只看目前組織脈絡的角色。 */
export interface OrgActionRule {
  readonly scope: 'org';
  readonly effect: 'read' | 'write';
  readonly orgRoles: readonly OrgRole[];
}

/**
 * 案件層動作。
 *
 * - `hostRoles`：主辦組織成員走這條路徑，依變體列出允許的組織角色。沒有列的變體不允許。
 * - `relations`：案件成員走這條路徑，依變體列出允許的關係。沒有列的變體不允許。
 * - `states`：允許的案件狀態。寫入動作必須不含終態。
 * - `onBehalfScope`：非 null 時，代管案件的主辦組織成員（受託人）走這個動作屬於代操作，必須通過委託範圍的四個條件。
 *   只適用 `managed` 變體的 `hostRoles` 路徑，屋主（`lessor` 關係）是本人，不查委託。
 */
export interface CaseActionRule {
  readonly scope: 'case';
  readonly effect: 'read' | 'write';
  readonly states: readonly CaseState[];
  readonly hostRoles: Readonly<Partial<Record<CaseVariant, readonly OrgRole[]>>>;
  readonly relations: Readonly<Partial<Record<CaseVariant, readonly CaseMemberRelation[]>>>;
  readonly onBehalfScope: MandateScope | null;
}

export type ActionRule = OrgActionRule | CaseActionRule;

/**
 * 動作表。鍵是動作 ID，對照 PRD P0-09 的權限表：
 * 自管案件的出租人、代管案件的屋主、代管業者、包租業者、包租案件的所有權人、承租人。
 */
export const ACTIONS = {
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
  // 讀合約：包租案件的所有權人讀不到（P0-09 AC5）。經紀業者只得讀合約（ADR-0016 決議 14）。
  'contract.read': {
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
      master_lease: ['lessor', 'lessee', 'co_lessee', 'practitioner', 'broker'],
      management: ['mandator', 'mandatary', 'practitioner'],
    },
    onBehalfScope: null,
  },
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
  // 擬約與送簽：代管業者是，代管案件的屋主否。送簽前提由 checkSendPreconditions 檢查。
  'contract.draft_send': {
    scope: 'case',
    effect: 'write',
    states: ['draft'],
    hostRoles: {
      self_managed: WRITE_ROLES,
      managed: WRITE_ROLES,
      master_lease: WRITE_ROLES,
      management: WRITE_ROLES,
    },
    relations: { self_managed: ['lessor'], master_lease: ['lessor'] },
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
  // 承租人報修：承租人與共同承租人的修繕權限只有報修。
  'repair.report': {
    scope: 'case',
    effect: 'write',
    states: OPERATING,
    hostRoles: {},
    relations: {
      self_managed: ['lessee', 'co_lessee'],
      managed: ['lessee', 'co_lessee'],
      master_lease: ['lessee', 'co_lessee'],
    },
    onBehalfScope: null,
  },
  // 建立與處理修繕紀錄：代管案件的屋主是，代管業者限委託範圍修繕。
  'repair.manage': {
    scope: 'case',
    effect: 'write',
    states: OPERATING,
    hostRoles: { self_managed: WRITE_ROLES, managed: WRITE_ROLES, master_lease: WRITE_ROLES },
    relations: { self_managed: ['lessor'], managed: ['lessor'], master_lease: ['lessor'] },
    onBehalfScope: 'repair',
  },
  // 確認點交：P0-09 表寫代管業者「是」，ADR-0023 決議 7 列為點交範圍的代操作，以 ADR 為準。
  'inspection.confirm': {
    scope: 'case',
    effect: 'write',
    states: ['active', 'move_out'],
    hostRoles: { self_managed: WRITE_ROLES, managed: WRITE_ROLES, master_lease: WRITE_ROLES },
    relations: {
      self_managed: ['lessor', 'lessee', 'co_lessee'],
      managed: ['lessor', 'lessee', 'co_lessee'],
      master_lease: ['lessor', 'lessee', 'co_lessee'],
    },
    onBehalfScope: 'inspection',
  },
  // 發起退租：承租人無此權限（ADR-0016 決議 7）。代管業者限委託範圍點交（ADR-0023 決議 7）。
  'move_out.start': {
    scope: 'case',
    effect: 'write',
    states: ['active'],
    hostRoles: { self_managed: WRITE_ROLES, managed: WRITE_ROLES, master_lease: WRITE_ROLES },
    relations: { self_managed: ['lessor'], managed: ['lessor'], master_lease: ['lessor'] },
    onBehalfScope: 'inspection',
  },
  // 對押金扣抵標示異議：只有承租人與共同承租人。
  'deposit.dispute': {
    scope: 'case',
    effect: 'write',
    states: ['move_out', 'settling'],
    hostRoles: {},
    relations: {
      self_managed: ['lessee', 'co_lessee'],
      managed: ['lessee', 'co_lessee'],
      master_lease: ['lessee', 'co_lessee'],
    },
    onBehalfScope: null,
  },
  // 發起移交：只適用代管租賃案件與它連結的委託管理案件（ADR-0024 決議 1）。
  // 租賃案件由屋主（lessor）或代管業者發起，委託管理案件由委託人、受託人或主辦組織發起。
  'handover.initiate': {
    scope: 'case',
    effect: 'write',
    states: OPERATING,
    hostRoles: { managed: WRITE_ROLES, management: WRITE_ROLES },
    relations: { managed: ['lessor'], management: ['mandator', 'mandatary'] },
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
  // 組織成員管理：只有 admin（P0-02、MIL-100 組織角色）。
  'org_member.manage': { scope: 'org', effect: 'write', orgRoles: ['admin'] },
  // 稽核紀錄匯出：只限 admin（P0-23 AC6）。
  'audit.export': { scope: 'org', effect: 'read', orgRoles: ['admin'] },
} as const satisfies Record<string, ActionRule>;

export type ActionId = keyof typeof ACTIONS;

export const ACTION_IDS = Object.keys(ACTIONS) as readonly ActionId[];
