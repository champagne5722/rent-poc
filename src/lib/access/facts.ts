// decideAccess 的輸入事實與輸出型別（ADR-0023 決議 6、7）。
// 事實由 authorize() 載入並以 now 算好，decideAccess 本身不碰時鐘（見 README）。

import type {
  BusinessType,
  CaseMemberRelation,
  LeaseCaseState,
  ManagementCaseState,
} from '../cases';
import type { MandateScope, OrgRole } from './actions';

/**
 * 代操作的四個條件（ADR-0023 決議 7，P0-11 AC4，P0-09 AC4）。
 * 全部由載入事實的人在查詢時點算好。第 4 條拆成兩個欄位，拒絕原因才能分開。
 */
export interface OnBehalfFacts {
  /** 條件 1：連結的委託管理案件是 `active`。 */
  mandateCaseActive: boolean;
  /** 條件 2：這個租賃單位在委託標的清單上。 */
  rentalUnitInMandate: boolean;
  /** 條件 3：這個租賃單位所在列的委託範圍。動作需要的範圍必須在裡面。 */
  mandateScopes: readonly MandateScope[];
  /** 條件 4：受託人的代管業別是 `verified`。 */
  practiceEntityVerified: boolean;
  /** 條件 4：至少一位可簽章的專任管理人員。 */
  hasSignableManager: boolean;
}

interface CaseAccessFactsBase {
  /** 目前身分的組織是不是這個案件的主辦組織。 */
  isHostOrgMember: boolean;
  /**
   * 目前身分的 party 在這個案件的成員關係。
   * 載入者必須只放在查詢時點 `valid_period` 有效的列（委託終止後受託人的列已關閉）。
   */
  relations: readonly CaseMemberRelation[];
}

export interface LeaseCaseAccessFacts extends CaseAccessFactsBase {
  kind: 'lease';
  state: LeaseCaseState;
  businessType: BusinessType;
  /**
   * 連結的委託管理案件的事實。只有代管案件需要。
   * 代管案件沒有連結的委託管理案件時是 `null`。其他業務類型忽略這個欄位。
   */
  onBehalf: OnBehalfFacts | null;
}

export interface ManagementCaseAccessFacts extends CaseAccessFactsBase {
  kind: 'management';
  state: ManagementCaseState;
}

export type CaseAccessFacts = LeaseCaseAccessFacts | ManagementCaseAccessFacts;

export interface AccessFacts {
  /**
   * 目前組織脈絡的角色。承租人與平台營運者身分沒有組織脈絡，是 `null`。
   * 角色是 `viewer` 時，兩條路徑的寫入一律拒絕。
   */
  orgRole: OrgRole | null;
  /** 案件層動作需要。組織層動作（成員管理、稽核匯出）可為 `null`。 */
  caseFacts: CaseAccessFacts | null;
}

/** 拒絕原因碼。對外與「資料不存在」同一個回應，原因碼只給內部與稽核使用（P0-02 AC1）。 */
export const ACCESS_DENY_REASONS = [
  'unknown_action',
  'no_org_context',
  'role_not_allowed',
  'viewer_read_only',
  'no_case',
  'not_a_member',
  'not_granted',
  'case_closed_read_only',
  'state_not_allowed',
  'no_mandate_link',
  'mandate_not_active',
  'unit_not_in_mandate',
  'scope_not_covered',
  'practice_not_verified',
  'no_signable_manager',
] as const;
export type AccessDenyReason = (typeof ACCESS_DENY_REASONS)[number];

/** 通過的路徑：組織角色、主辦組織成員、案件成員。稽核用。 */
export type AccessVia = 'org_role' | 'host_org' | 'case_relation';

export type AccessDecision =
  | {
      allowed: true;
      via: AccessVia;
      /** 這次允許是不是代操作（受託人依委託範圍代屋主執行），稽核必須標示。 */
      onBehalf: boolean;
    }
  | { allowed: false; reason: AccessDenyReason };
