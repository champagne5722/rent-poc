// 案件建立（ADR-0023 決議 1、4、5，ADR-0024 決議 2 到 4，ADR-0030 決議 1、5）。
// 四種案件的主辦組織規則在這裡：租賃、委託管理、包租、轉租。用詞與舊值的對照見 case-kind.ts。
// 純函式，沒有 I/O。事實由呼叫端查好傳入，這裡只判斷「能不能建」與「建出什麼」。
// 寫入案件、成員與案件事件由之後的 repository 負責，見同目錄 README.md。

import { HOST_ORG_KINDS_FOR_CASE_KIND, type StatutoryCaseKind } from './case-kind';
import {
  buildCaseEvent,
  type BusinessType,
  type CaseEvent,
  type CaseMemberRelation,
  type LeaseCaseState,
  type ManagementCaseState,
} from './transitions';

/** 組織種類（ADR-0022 的 orgKind 去掉平台營運者）：屋主組織、執業主體組織。 */
export const ORG_KINDS = ['owner', 'practice'] as const;
export type OrgKind = (typeof ORG_KINDS)[number];

/** 業別、證書、任職共用的驗證三態（ADR-0017 決議 3）。 */
export type CredentialStatus = 'pending' | 'verified' | 'lapsed';

/**
 * 代管與包租案件對應的執業主體業別（P0-02 AC4）。
 * 業務類型的 `master_lease` 是舊值，指轉租（見 case-kind.ts）。新程式碼改用 PRACTICE_CATEGORY_FOR_CASE_KIND。
 */
export const PRACTICE_CATEGORY_FOR_BUSINESS_TYPE = {
  managed: 'management',
  master_lease: 'master_lease',
} as const;

/** 案件種類對應的執業主體業別（ADR-0030 決議 1）。租賃案件只有代管要看業別，所以不在表內。 */
export const PRACTICE_CATEGORY_FOR_CASE_KIND = {
  management: 'management',
  master_lease: 'master_lease',
  sublease: 'master_lease',
} as const;

/** 各組織種類在「建立新租賃案件」時允許的業務類型（ADR-0023 決議 1）。 */
export const NEW_LEASE_BUSINESS_TYPES: Record<OrgKind, readonly BusinessType[]> = {
  owner: ['self_managed'],
  practice: ['managed', 'master_lease'],
};

/** 接收方在「建立後繼案件」時允許的業務類型。移交只適用代管，結果是改派新受託人或交回屋主（ADR-0024 決議 1、2）。 */
export const SUCCESSOR_BUSINESS_TYPES: Record<OrgKind, readonly BusinessType[]> = {
  owner: ['self_managed'],
  practice: ['managed'],
};

interface HostOrg {
  orgId: string;
  kind: OrgKind;
}

/** 執業主體組織的事實：對應業別的驗證狀態，以及是否至少有一位可簽章的專任管理人員。 */
export interface PracticeFacts {
  /** 業務類型對應業別的狀態。沒有登錄業別時是 null。 */
  entityStatus: CredentialStatus | null;
  hasSignableManager: boolean;
}

/** 代管案件要連到的委託管理案件（ADR-0023 決議 4）。 */
export interface MandateCaseFacts {
  id: string;
  state: ManagementCaseState;
  /** 委託標的清單是否涵蓋這個租賃單位。 */
  coversRentalUnit: boolean;
}

/** 轉租案件要連到的包租案件（ADR-0030 決議 5）。 */
export interface MasterLeaseCaseFacts {
  id: string;
  /** 包租案件的主辦組織。必須等於轉租案件的主辦組織，否則視為沒有。 */
  orgId: string;
  state: LeaseCaseState;
  /** 包租案件的租賃單位是否就是這個租賃單位。 */
  coversRentalUnit: boolean;
}

/** `new_lease` 能建的案件種類。委託管理案件走 `new_management`。 */
export type NewLeaseCaseKind = Exclude<StatutoryCaseKind, 'management'>;

/** 建約 wizard 第一步：建立租賃案件（ADR-0023 決議 1）。 */
export interface NewLeaseCaseInput {
  type: 'new_lease';
  caseId: string;
  rentalUnitId: string;
  hostOrg: HostOrg;
  /**
   * 案件種類（ADR-0030）。不傳時由業務類型推出：`master_lease` 當轉租案件，其餘當租賃案件。
   * 包租案件（屋主租給包租業者）一定要明傳，因為資料上它的業務類型是 `self_managed`。
   */
  caseKind?: NewLeaseCaseKind;
  /** 業務類型是舊欄位：租賃案件是 `self_managed` 或 `managed`，轉租案件是舊值 `master_lease`，包租案件是 `self_managed`。 */
  businessType: BusinessType;
  /** 租賃案件是出租人，代管案件是屋主，包租案件是屋主，轉租案件是包租業者（ADR-0023 決議 5，ADR-0030 決議 1）。 */
  lessorPartyId: string;
  /** 只用於轉租案件，取自包租案件的出租人（屋主）。找不到時是 null。 */
  ownerPartyId: string | null;
  /** 主辦組織勾選居間並選了經紀業者時才有。 */
  brokerPartyId: string | null;
  /** 主辦組織是執業主體組織時才需要。 */
  practice: PracticeFacts | null;
  /** 只有代管案件需要。 */
  mandateCase: MandateCaseFacts | null;
  /** 只有轉租案件需要。呼叫端只能用目前主辦組織看得到的案件查，見 case-store 的 findCoveringMasterLeaseCase。 */
  masterLeaseCase: MasterLeaseCaseFacts | null;
  /**
   * 過渡用，MIL-203 移除。舊建約精靈由屋主組織建立「承租人是包租業者」的自管租賃案件，現在歸為包租案件。
   * 只放寬包租案件的主辦組織，其他檢查不變。新的建立入口不得傳這個旗標。
   */
  transitionalOwnerHosted?: boolean;
}

/** 建立委託管理案件（ADR-0016 決議 9、ADR-0023 決議 5）。 */
export interface NewManagementCaseInput {
  type: 'new_management';
  caseId: string;
  hostOrg: HostOrg;
  mandatorPartyId: string;
  mandataryPartyId: string;
  /** 委託期間的最後一天（含），YYYY-MM-DD。期限未定是 null。 */
  validUntil: string | null;
  /** 主辦組織是代管業者（ADR-0030 決議 1），對應業別必須已驗證。 */
  practice: PracticeFacts | null;
}

/** 可以有後繼案件的案件種類。移交只適用租賃案件（ADR-0024 決議 1）。 */
const SUCCESSOR_CASE_KINDS: readonly NewLeaseCaseKind[] = ['lease'];

function isSuccessorCaseKind(kind: StatutoryCaseKind): kind is NewLeaseCaseKind {
  return (SUCCESSOR_CASE_KINDS as readonly string[]).includes(kind);
}

/** 移交生效時，接收方組織建立後繼案件（ADR-0024 決議 2 到 4）。 */
export interface SuccessorCaseInput {
  type: 'successor_lease';
  caseId: string;
  /** 與舊案件相同（ADR-0013 決議 9）。 */
  rentalUnitId: string;
  predecessorCaseId: string;
  /**
   * 原案件的案件種類。後繼案件沿用它（ADR-0030 決議 2，MIL-198）。
   * 移交只適用租賃代管案件（ADR-0024 決議 1），所以只接受租賃案件。其他種類被擋下。
   */
  predecessorCaseKind: StatutoryCaseKind;
  handoverId: string;
  receiverOrg: HostOrg;
  businessType: BusinessType;
  /** 接收方案件的出租人：代管是屋主，改自管時是屋主本人。 */
  lessorPartyId: string;
  /** 舊案件的承租人與共同承租人，承接原合約，所以一併帶過來。 */
  lesseePartyIds: readonly string[];
  coLesseePartyIds: readonly string[];
}

export type CaseCreationInput = NewLeaseCaseInput | NewManagementCaseInput | SuccessorCaseInput;

interface NewCaseBase {
  id: string;
  orgId: string;
  stateVersion: 0;
  /** 後繼案件不建合約列（ADR-0024 決議 4），新案件的合約由之後的送簽流程掛上。 */
  currentContractId: null;
}

export interface NewLeaseCase extends NewCaseBase {
  kind: 'lease';
  state: 'draft' | 'active';
  caseKind: NewLeaseCaseKind;
  businessType: BusinessType;
  rentalUnitId: string;
  /** 代管案件連到的委託管理案件。 */
  linkedMandateCaseId: string | null;
  /** 轉租案件連到的包租案件（ADR-0030 決議 5）。 */
  linkedMasterLeaseCaseId: string | null;
  predecessorCaseId: string | null;
  handoverId: string | null;
}

export interface NewManagementCase extends NewCaseBase {
  kind: 'management';
  caseKind: 'management';
  state: 'draft';
  validUntil: string | null;
}

export type NewCase = NewLeaseCase | NewManagementCase;

export interface NewCaseMember {
  partyId: string;
  relation: CaseMemberRelation;
}

export type CreationBlockCode =
  | 'business_type_not_allowed'
  | 'case_kind_not_allowed'
  | 'host_org_not_allowed'
  | 'practice_entity_not_verified'
  | 'no_signable_manager'
  | 'no_valid_mandate'
  | 'no_valid_master_lease'
  | 'invalid_party'
  | 'mandator_equals_mandatary'
  | 'invalid_valid_until';

export interface CreationBlockReason {
  code: CreationBlockCode;
  message: string;
}

export type CaseCreationResult =
  | { ok: true; case: NewCase; members: NewCaseMember[]; event: CaseEvent }
  | { ok: false; reasons: CreationBlockReason[] };

const MESSAGES: Record<CreationBlockCode, string> = {
  case_kind_not_allowed: '移交只適用租賃案件。後繼案件沿用原案件的案件種類，其他種類的案件不得建立後繼案件。',
  business_type_not_allowed: '這個組織不得建立這種業務類型的案件。屋主組織只得建自管，執業主體組織只得建代管。',
  host_org_not_allowed: '這個組織不得建立這種案件。委託管理案件、包租案件與轉租案件只得由執業主體組織建立。',
  practice_entity_not_verified: '執業主體的對應業別不是已驗證，不得建立這種案件。',
  no_signable_manager: '沒有可簽章的專任管理人員，不得建立這種案件。',
  no_valid_mandate: '代管案件必須連到有效的委託管理案件，且委託標的必須涵蓋這個租賃單位。',
  // 不區分「沒有包租案件」「包租案件不是這個組織的」「沒涵蓋這個租賃單位」，避免洩漏別的組織的案件
  no_valid_master_lease: '轉租案件必須連到有效的包租案件，且包租案件必須涵蓋這個租賃單位。',
  invalid_party: '案件成員的當事人 ID 不得是空白。',
  mandator_equals_mandatary: '委託人與受託人不得是同一個當事人。',
  invalid_valid_until: '委託期間的最後一天必須是有效的 YYYY-MM-DD 日期。',
};

/** 由輸入決定能不能建案件，以及建出的案件、成員與案件事件。被擋下時回傳全部原因。 */
export function decideCaseCreation(input: CaseCreationInput, now: Date): CaseCreationResult {
  switch (input.type) {
    case 'new_lease':
      return decideNewLease(input, now);
    case 'new_management':
      return decideNewManagement(input, now);
    case 'successor_lease':
      return decideSuccessor(input, now);
  }
}

/** 沒傳案件種類時，由舊的業務類型推出（舊呼叫端相容）。 */
function resolveLeaseCaseKind(input: NewLeaseCaseInput): NewLeaseCaseKind {
  return input.caseKind ?? (input.businessType === 'master_lease' ? 'sublease' : 'lease');
}

function decideNewLease(input: NewLeaseCaseInput, now: Date): CaseCreationResult {
  const codes: CreationBlockCode[] = [];
  const { hostOrg, businessType } = input;
  const caseKind = resolveLeaseCaseKind(input);

  if (caseKind === 'lease') {
    if (!NEW_LEASE_BUSINESS_TYPES[hostOrg.kind].includes(businessType)) codes.push('business_type_not_allowed');
  } else {
    // 包租案件的業務類型是 self_managed，轉租案件是舊值 master_lease（case-kind.ts）
    const expected: BusinessType = caseKind === 'master_lease' ? 'self_managed' : 'master_lease';
    if (businessType !== expected) codes.push('business_type_not_allowed');
    const ownerHostedAllowed = caseKind === 'master_lease' && input.transitionalOwnerHosted === true && hostOrg.kind === 'owner';
    if (!HOST_ORG_KINDS_FOR_CASE_KIND[caseKind].includes(hostOrg.kind) && !ownerHostedAllowed) {
      codes.push('host_org_not_allowed');
    }
  }

  // 代管、包租、轉租由執業主體組織主辦，才需要業別驗證與專任管理人員
  const needsPracticeChecks = hostOrg.kind === 'practice' && (caseKind !== 'lease' || businessType === 'managed');
  if (needsPracticeChecks) codes.push(...practiceBlockCodes(input.practice));

  const mandate = input.mandateCase;
  if (caseKind === 'lease' && businessType === 'managed' && !(mandate?.state === 'active' && mandate.coversRentalUnit)) {
    codes.push('no_valid_mandate');
  }

  // 轉租案件必須連到同一個主辦組織的有效包租案件，而且它涵蓋這個租賃單位（ADR-0030 決議 5）
  const masterLease = input.masterLeaseCase;
  const masterLeaseValid =
    masterLease !== null &&
    masterLease.orgId === hostOrg.orgId &&
    masterLease.state === 'active' &&
    masterLease.coversRentalUnit;
  if (caseKind === 'sublease' && !masterLeaseValid) codes.push('no_valid_master_lease');

  const partyIds = [input.lessorPartyId, input.brokerPartyId, caseKind === 'sublease' ? input.ownerPartyId : null];
  if (partyIds.some((id) => id !== null && isBlank(id))) codes.push('invalid_party');

  if (codes.length > 0) return blocked(codes);

  const linkedMandateCaseId = caseKind === 'lease' && businessType === 'managed' ? (mandate?.id ?? null) : null;
  const linkedMasterLeaseCaseId = caseKind === 'sublease' ? (masterLease?.id ?? null) : null;
  const members: NewCaseMember[] = [{ partyId: input.lessorPartyId, relation: 'lessor' }];
  if (caseKind === 'sublease' && input.ownerPartyId !== null) {
    members.push({ partyId: input.ownerPartyId, relation: 'owner' });
  }
  if (input.brokerPartyId !== null) members.push({ partyId: input.brokerPartyId, relation: 'broker' });

  return {
    ok: true,
    case: {
      kind: 'lease',
      id: input.caseId,
      orgId: hostOrg.orgId,
      state: 'draft',
      stateVersion: 0,
      currentContractId: null,
      caseKind,
      businessType,
      rentalUnitId: input.rentalUnitId,
      linkedMandateCaseId,
      linkedMasterLeaseCaseId,
      predecessorCaseId: null,
      handoverId: null,
    },
    members,
    event: buildCaseEvent('created', now, {
      kind: 'lease',
      caseKind,
      businessType,
      rentalUnitId: input.rentalUnitId,
      linkedMandateCaseId,
      linkedMasterLeaseCaseId,
    }),
  };
}

function decideNewManagement(input: NewManagementCaseInput, now: Date): CaseCreationResult {
  const codes: CreationBlockCode[] = [];
  // 委託管理案件由代管業者主辦（ADR-0030 決議 1）。屋主不上線時由業者上傳紙本契約書，主辦組織仍是業者
  if (!HOST_ORG_KINDS_FOR_CASE_KIND.management.includes(input.hostOrg.kind)) {
    codes.push('host_org_not_allowed');
  } else {
    codes.push(...practiceBlockCodes(input.practice));
  }
  if (isBlank(input.mandatorPartyId) || isBlank(input.mandataryPartyId)) {
    codes.push('invalid_party');
  } else if (input.mandatorPartyId === input.mandataryPartyId) {
    codes.push('mandator_equals_mandatary');
  }
  if (input.validUntil !== null && !isValidDate(input.validUntil)) codes.push('invalid_valid_until');

  if (codes.length > 0) return blocked(codes);

  return {
    ok: true,
    case: {
      kind: 'management',
      caseKind: 'management',
      id: input.caseId,
      orgId: input.hostOrg.orgId,
      state: 'draft',
      stateVersion: 0,
      currentContractId: null,
      validUntil: input.validUntil,
    },
    members: [
      { partyId: input.mandatorPartyId, relation: 'mandator' },
      { partyId: input.mandataryPartyId, relation: 'mandatary' },
    ],
    event: buildCaseEvent('created', now, { kind: 'management', caseKind: 'management', validUntil: input.validUntil }),
  };
}

/** 執業主體組織主辦時的共同檢查：對應業別已驗證，且至少一位可簽章的專任管理人員。 */
function practiceBlockCodes(practice: PracticeFacts | null): CreationBlockCode[] {
  const codes: CreationBlockCode[] = [];
  if (practice?.entityStatus !== 'verified') codes.push('practice_entity_not_verified');
  if (!practice?.hasSignableManager) codes.push('no_signable_manager');
  return codes;
}

function decideSuccessor(input: SuccessorCaseInput, now: Date): CaseCreationResult {
  const codes: CreationBlockCode[] = [];
  const { receiverOrg, businessType } = input;

  // 委託是否有效、接收方是否已驗證，由移交的擋下條件負責（ADR-0024 決議 12），這裡不重查
  if (!isSuccessorCaseKind(input.predecessorCaseKind)) codes.push('case_kind_not_allowed');
  if (!SUCCESSOR_BUSINESS_TYPES[receiverOrg.kind].includes(businessType)) codes.push('business_type_not_allowed');
  if ([input.lessorPartyId, ...input.lesseePartyIds, ...input.coLesseePartyIds].some(isBlank)) {
    codes.push('invalid_party');
  }

  if (codes.length > 0 || !isSuccessorCaseKind(input.predecessorCaseKind)) return blocked(codes);

  const members: NewCaseMember[] = [{ partyId: input.lessorPartyId, relation: 'lessor' }];
  const lessees = new Set(input.lesseePartyIds);
  for (const partyId of lessees) members.push({ partyId, relation: 'lessee' });
  // 同一人同時在兩份清單時，只留承租人身分
  for (const partyId of new Set(input.coLesseePartyIds)) {
    if (!lessees.has(partyId)) members.push({ partyId, relation: 'co_lessee' });
  }

  return {
    ok: true,
    case: {
      kind: 'lease',
      id: input.caseId,
      orgId: receiverOrg.orgId,
      // 後繼案件直接生 active（ADR-0024 決議 4），因為承接的是已生效的租約
      state: 'active',
      stateVersion: 0,
      currentContractId: null,
      caseKind: input.predecessorCaseKind,
      businessType,
      rentalUnitId: input.rentalUnitId,
      linkedMandateCaseId: null,
      linkedMasterLeaseCaseId: null,
      predecessorCaseId: input.predecessorCaseId,
      handoverId: input.handoverId,
    },
    members,
    event: buildCaseEvent('succeeded', now, {
      kind: 'lease',
      caseKind: input.predecessorCaseKind,
      businessType,
      rentalUnitId: input.rentalUnitId,
      predecessorCaseId: input.predecessorCaseId,
      handoverId: input.handoverId,
    }),
  };
}

function blocked(codes: CreationBlockCode[]): CaseCreationResult {
  return { ok: false, reasons: codes.map((code) => ({ code, message: MESSAGES[code] })) };
}

function isBlank(value: string): boolean {
  return value.trim() === '';
}

/** 嚴格的 YYYY-MM-DD，且是日曆上存在的日期。 */
function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
