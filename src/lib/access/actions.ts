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
  /**
   * 物件還沒歸屬任何案件時，改用哪個組織層動作判斷（MIL-108 剩餘範圍）。沒有這個欄位的動作，
   * 物件沒有案件就拒絕（`no_case`）。只給合約動作用：MIL-115 建案件表並遷移既有合約後，
   * 所有合約都有案件，這條路徑不再被走到。
   */
  readonly uncased?: 'uncased_contract.read' | 'uncased_contract.write';
}

export type ActionRule = OrgActionRule | CaseActionRule;

/**
 * 合約生命週期動作：與擬約送簽同一批人（主辦組織的 admin、staff，自管與包租的出租人），
 * 差別只在允許的案件狀態。送簽後撤回或拒簽，案件回 `draft`（cases README），所以複製為新草稿在 `draft`。
 * 代管案件的屋主不在內（P0-09：代管案件的屋主不得擬約與送簽）。
 */
function contractLifecycle(states: readonly CaseState[]): CaseActionRule {
  return {
    scope: 'case',
    effect: 'write',
    states,
    hostRoles: {
      self_managed: WRITE_ROLES,
      managed: WRITE_ROLES,
      master_lease: WRITE_ROLES,
      management: WRITE_ROLES,
    },
    relations: { self_managed: ['lessor'], master_lease: ['lessor'] },
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
    uncased: 'uncased_contract.read',
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
    uncased: 'uncased_contract.write',
  },
  ...CONTRACT_LIFECYCLE,
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
  // 組織成員列表：所有角色。待處理邀請只給 admin，由載入資料的人過濾。
  'org_member.read': { scope: 'org', effect: 'read', orgRoles: ALL_ROLES },
  // 物件在組織層，沒有案件：讀取所有角色，寫入 admin 與 staff，viewer 被拒。
  'property.read': { scope: 'org', effect: 'read', orgRoles: ALL_ROLES },
  'property.manage': { scope: 'org', effect: 'write', orgRoles: WRITE_ROLES },
  // 案件清單（MIL-115）：列出目前組織主辦的案件，加上自己是成員的別組織案件。所有角色可讀。
  // 清單內每一列能看到什麼，由 RLS 的成員讀取政策決定；進入單一案件另走 case.read_summary。
  'case.list': { scope: 'org', effect: 'read', orgRoles: ALL_ROLES },
  // 還沒歸屬案件的合約（MIL-115 遷移前）：依組織角色。案件動作的 `uncased` 欄位指向這兩列。
  'uncased_contract.read': { scope: 'org', effect: 'read', orgRoles: ALL_ROLES },
  'uncased_contract.write': { scope: 'org', effect: 'write', orgRoles: WRITE_ROLES },
  // 稽核紀錄匯出：只限 admin（P0-23 AC6）。
  'audit.export': { scope: 'org', effect: 'read', orgRoles: ['admin'] },
  // 執業主體端（MIL-109）：看自己的登錄進度，所有角色。送件與補件是寫入，admin 與 staff，viewer 被拒。
  // 組織型態必須是 practice 由呼叫端另外檢查，動作表只看組織角色。審核台不走這裡：它靠平台營運者身分，不是組織角色。
  'practice_registry.read': { scope: 'org', effect: 'read', orgRoles: ALL_ROLES },
  'practice_registry.submit': { scope: 'org', effect: 'write', orgRoles: WRITE_ROLES },
  // 執業主體批次查詢（F 線資產總覽，MIL-94）：任何組織成員，只回名稱、稱謂與驗證狀態。
  'practice_entity.lookup': { scope: 'org', effect: 'read', orgRoles: ALL_ROLES },
} as const satisfies Record<string, ActionRule>;

export type ActionId = keyof typeof ACTIONS;

export const ACTION_IDS = Object.keys(ACTIONS) as readonly ActionId[];

/**
 * 物件還沒歸屬案件時，這個動作改用哪個組織層動作判斷。
 * 組織層動作原樣回傳。案件動作有 `uncased` 欄位時回傳該欄位，其餘回 `null`，載入者必須拒絕。
 * 帳務、修繕、點交這類動作一定要有案件，不得因為沒有案件而放行。
 */
export function actionForUncasedObject(action: ActionId): ActionId | null {
  const rule: ActionRule = ACTIONS[action];
  if (rule.scope === 'org') return action;
  return rule.uncased ?? null;
}
