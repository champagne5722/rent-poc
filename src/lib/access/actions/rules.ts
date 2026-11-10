// 動作表的共用規則型別與常數（ADR-0023 決議 6、7，PRD P0-09 權限表）。
// 純常數與型別，沒有 I/O。各模組的動作在同目錄的 `<模組>.ts`，由上一層的 `actions.ts` 彙總。
// 模組檔從這裡取型別與狀態、角色常數，不要反向 import `actions.ts`，以免循環依賴。

import {
  LEASE_CASE_STATES,
  MANAGEMENT_CASE_STATES,
  type CaseMemberRelation,
  type CaseRuleVariant,
  type CaseState,
} from '../../cases';

/** 組織角色（ADR-0022）：管理員、業務人員、唯讀。 */
export const ORG_ROLES = ['admin', 'staff', 'viewer'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** 委託範圍（ADR-0023 決議 7、GLOSSARY）：收租、押金管理、修繕、點交。 */
export const MANDATE_SCOPES = ['rent_collection', 'deposit_management', 'repair', 'inspection'] as const;
export type MandateScope = (typeof MANDATE_SCOPES)[number];

/**
 * 案件變體（MIL-198）：由案件種類推出，租賃案件再依業務類型分自管與代管，共五種（見 cases/rule-variant.ts）。
 * 動作表依變體決定主辦組織與案件關係的意義，例如 `lessor` 關係在租賃代管案件是屋主，在轉租案件是包租業者。
 * 包租案件沿用租賃自管的規則（待法務確認），轉租案件沿用原本業務類型 `master_lease` 的規則。
 */
export type CaseVariant = CaseRuleVariant;

/** 終態：只允許讀取（ADR-0016 決議 15，P0-09 AC6）。不結束成員的 valid_period。 */
export const TERMINAL_CASE_STATES: readonly CaseState[] = ['closed', 'aborted', 'terminated', 'expired'];

export const ALL_STATES: readonly CaseState[] = [...new Set<CaseState>([...LEASE_CASE_STATES, ...MANAGEMENT_CASE_STATES])];
/** 簽約完成後、結案前。入帳、押金、修繕等日常動作用。 */
export const OPERATING: readonly CaseState[] = ['active', 'move_out', 'settling'];
/** 非終態。成員管理用。 */
export const OPEN: readonly CaseState[] = ['draft', 'signing', 'active', 'move_out', 'settling'];

export const ALL_ROLES: readonly OrgRole[] = ['admin', 'staff', 'viewer'];
export const WRITE_ROLES: readonly OrgRole[] = ['admin', 'staff'];

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
 *   只適用 `lease_managed` 變體的 `hostRoles` 路徑，屋主（`lessor` 關係）是本人，不查委託。
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
