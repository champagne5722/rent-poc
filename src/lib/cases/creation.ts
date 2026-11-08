// 案件建立（ADR-0023 決議 1、4、5，ADR-0024 決議 2 到 4）。
// 純函式，沒有 I/O。事實由呼叫端查好傳入，這裡只判斷「能不能建」與「建出什麼」。
// 寫入案件、成員與案件事件由之後的 repository 負責，見同目錄 README.md。

import {
  event,
  type BusinessType,
  type CaseEvent,
  type CaseMemberRelation,
  type ManagementCaseState,
} from './transitions';

/** 組織種類（ADR-0022 的 orgKind 去掉平台營運者）：屋主組織、執業主體組織。 */
export const ORG_KINDS = ['owner', 'practice'] as const;
export type OrgKind = (typeof ORG_KINDS)[number];

/** 業別、證書、任職共用的驗證三態（ADR-0017 決議 3）。 */
export type CredentialStatus = 'pending' | 'verified' | 'lapsed';

/** 代管與包租案件對應的執業主體業別（P0-02 AC4）。 */
export const PRACTICE_CATEGORY_FOR_BUSINESS_TYPE = {
  managed: 'management',
  master_lease: 'master_lease',
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

/** 建約 wizard 第一步：建立租賃案件（ADR-0023 決議 1）。 */
export interface NewLeaseCaseInput {
  type: 'new_lease';
  caseId: string;
  rentalUnitId: string;
  hostOrg: HostOrg;
  businessType: BusinessType;
  /** 代管案件是屋主，包租案件是包租業者，自管案件是出租人（ADR-0023 決議 5）。 */
  lessorPartyId: string;
  /** 只用於包租案件，取自包租業者與屋主的自管案件。找不到時是 null。 */
  ownerPartyId: string | null;
  /** 主辦組織勾選居間並選了經紀業者時才有。 */
  brokerPartyId: string | null;
  /** 主辦組織是執業主體組織時才需要。 */
  practice: PracticeFacts | null;
  /** 只有代管案件需要。 */
  mandateCase: MandateCaseFacts | null;
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
}

/** 移交生效時，接收方組織建立後繼案件（ADR-0024 決議 2 到 4）。 */
export interface SuccessorCaseInput {
  type: 'successor_lease';
  caseId: string;
  /** 與舊案件相同（ADR-0013 決議 9）。 */
  rentalUnitId: string;
  predecessorCaseId: string;
  handoverId: string;
  receiverOrg: HostOrg;
  businessType: BusinessType;
  /** 接收方案件的出租人：代管是屋主，改自管時是屋主本人。 */
  lessorPartyId: string;
  /** 舊案件的承租人與共同承租人，承接原租約，所以一併帶過來。 */
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
  businessType: BusinessType;
  rentalUnitId: string;
  /** 代管案件連到的委託管理案件。 */
  linkedMandateCaseId: string | null;
  predecessorCaseId: string | null;
  handoverId: string | null;
}

export interface NewManagementCase extends NewCaseBase {
  kind: 'management';
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
  | 'practice_entity_not_verified'
  | 'no_signable_manager'
  | 'no_valid_mandate'
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
  business_type_not_allowed: '這個組織不能建立這種業務類型的案件。屋主組織只能建自管，執業主體組織只能建代管或包租。',
  practice_entity_not_verified: '執業主體的對應業別不是已驗證，不能建立代管或包租案件。',
  no_signable_manager: '沒有可簽章的專任管理人員，不能建立代管或包租案件。',
  no_valid_mandate: '代管案件必須連到有效的委託管理案件，且委託標的要涵蓋這個租賃單位。',
  invalid_party: '案件成員的當事人 ID 不能是空白。',
  mandator_equals_mandatary: '委託人與受託人不能是同一個當事人。',
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

function decideNewLease(input: NewLeaseCaseInput, now: Date): CaseCreationResult {
  const codes: CreationBlockCode[] = [];
  const { hostOrg, businessType } = input;

  if (!NEW_LEASE_BUSINESS_TYPES[hostOrg.kind].includes(businessType)) codes.push('business_type_not_allowed');

  // 代管與包租由執業主體組織主辦，才需要業別驗證與專任管理人員
  if (hostOrg.kind === 'practice' && businessType !== 'self_managed') {
    if (input.practice?.entityStatus !== 'verified') codes.push('practice_entity_not_verified');
    if (!input.practice?.hasSignableManager) codes.push('no_signable_manager');
  }

  const mandate = input.mandateCase;
  if (businessType === 'managed' && !(mandate?.state === 'active' && mandate.coversRentalUnit)) {
    codes.push('no_valid_mandate');
  }

  const partyIds = [input.lessorPartyId, input.brokerPartyId, businessType === 'master_lease' ? input.ownerPartyId : null];
  if (partyIds.some((id) => id !== null && isBlank(id))) codes.push('invalid_party');

  if (codes.length > 0) return blocked(codes);

  const linkedMandateCaseId = businessType === 'managed' ? (mandate?.id ?? null) : null;
  const members: NewCaseMember[] = [{ partyId: input.lessorPartyId, relation: 'lessor' }];
  if (businessType === 'master_lease' && input.ownerPartyId !== null) {
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
      businessType,
      rentalUnitId: input.rentalUnitId,
      linkedMandateCaseId,
      predecessorCaseId: null,
      handoverId: null,
    },
    members,
    event: event('created', now, {
      kind: 'lease',
      businessType,
      rentalUnitId: input.rentalUnitId,
      linkedMandateCaseId,
    }),
  };
}

function decideNewManagement(input: NewManagementCaseInput, now: Date): CaseCreationResult {
  const codes: CreationBlockCode[] = [];
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
    event: event('created', now, { kind: 'management', validUntil: input.validUntil }),
  };
}

function decideSuccessor(input: SuccessorCaseInput, now: Date): CaseCreationResult {
  const codes: CreationBlockCode[] = [];
  const { receiverOrg, businessType } = input;

  // 委託是否有效、接收方是否已驗證，由移交的擋下條件負責（ADR-0024 決議 12），這裡不重查
  if (!SUCCESSOR_BUSINESS_TYPES[receiverOrg.kind].includes(businessType)) codes.push('business_type_not_allowed');
  if ([input.lessorPartyId, ...input.lesseePartyIds, ...input.coLesseePartyIds].some(isBlank)) {
    codes.push('invalid_party');
  }

  if (codes.length > 0) return blocked(codes);

  const members: NewCaseMember[] = [{ partyId: input.lessorPartyId, relation: 'lessor' }];
  for (const partyId of new Set(input.lesseePartyIds)) members.push({ partyId, relation: 'lessee' });
  for (const partyId of new Set(input.coLesseePartyIds)) members.push({ partyId, relation: 'co_lessee' });

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
      businessType,
      rentalUnitId: input.rentalUnitId,
      linkedMandateCaseId: null,
      predecessorCaseId: input.predecessorCaseId,
      handoverId: input.handoverId,
    },
    members,
    event: event('succeeded', now, {
      kind: 'lease',
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
