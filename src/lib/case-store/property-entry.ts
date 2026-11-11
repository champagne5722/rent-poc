import {
  availableCaseKinds,
  businessTypeForNewCase,
  practiceFactsFor,
  type BusinessType,
  type CaseEntryFacts,
  type NewLeaseCaseKind,
  type OrgKind,
  type PracticeEligibility,
} from '../cases';
import { contractTypeForCaseKind } from '../contract-types/case-kind';
import type { ContractType } from '../labels';
import { canCreateCase } from '../ownership/gate';
import { getOwnershipGate } from '../ownership/repository';
import type { OrgTx } from '../pg/with-tx';
import { getMyRegistration } from '../practice-entities/applicant';
import { listOrgEmployments } from '../practitioners/applicant';
import { signableManagers } from '../practitioners/signable-managers';
import type { ContractRoutingConditions } from '../types';
import { createLeaseCase } from './commands';
import { findCoveringMandateCase, findCoveringMasterLeaseCase } from './repository';

// 從物件建立案件的入口（MIL-209，ADR-0030 決議 1、5）。
// 兩件事：讀「這個物件能建哪些案件」，以及依案件種類建立案件。
// 呼叫端已在 `inOrgTx` 內並已 authorize()。這裡所有查詢都只看目前組織自己的資料，
// 所以別的組織的物件與案件不會進到判斷裡，呼叫端也無法傳入上層案件的 ID。

/** 物件的案件參數，與 `createLeaseCase` 的 `property` 相同。 */
export interface EntryProperty {
  id: string;
  name: string;
  address: string;
  rental_unit_id: string;
}

/**
 * 由案件種類決定合約類型，全部集中在這裡（ADR-0030 決議 6）。
 * 對應表在 `contractTypeForCaseKind`（MIL-199）：租賃案件建租賃合約，包租案件建包租合約，轉租案件建轉租合約。
 */
export function contractTypeForNewCase(caseKind: NewLeaseCaseKind): ContractType {
  return contractTypeForCaseKind(caseKind);
}

/**
 * 新路徑的分流條件，由案件種類推出（與 `caseKindOf` 的換法相同，所以案件與合約的案件種類一致）。
 * 呼叫端不能傳 `lesseeIsMasterLessor`：包租案件由案件種類決定，不由使用者勾選。
 * 這個組織種類不能建這種案件時回 null。
 */
export function routingForNewCase(orgKind: OrgKind, caseKind: NewLeaseCaseKind, brokerMediated: boolean): ContractRoutingConditions | null {
  const businessType: BusinessType | null = businessTypeForNewCase(orgKind, caseKind);
  if (businessType === null) return null;
  return { businessType, lesseeIsMasterLessor: caseKind === 'master_lease', brokerMediated };
}

/**
 * 執業主體組織的資格事實。只在執業主體組織的脈絡內呼叫。
 * - 業別：取自 `registry.my_registration()`，只看狀態。
 * - 可簽章的專任管理人員：組織內至少有一位租賃住宅管理人員，業別、證書、任職三層都已驗證，且任職期間與證書效期涵蓋現在。
 *   判定用 `credentialStatusAt`（ADR-0017 決議 6）。待法務確認：包租業者是否也要求專任管理人員（MIL-62）。
 */
export async function loadPracticeEligibility(tx: OrgTx, now: Date = new Date()): Promise<PracticeEligibility> {
  const registration = await getMyRegistration(tx);
  const licenseOf = (kind: 'management' | 'master_lease') => registration?.licenses.find((l) => l.kind === kind)?.state ?? null;
  const licenses = { management: licenseOf('management'), master_lease: licenseOf('master_lease') };
  // 資格事實只算「管理人員」。兩種業別共用同一批人員，所以業別層用任一已驗證的業別判定，各業別自己的狀態在 licenses
  const anyVerified = licenses.management === 'verified' || licenses.master_lease === 'verified';
  const employments = anyVerified ? await listOrgEmployments(tx) : [];
  const hasSignableManager = signableManagers(employments, now).length > 0;
  return { licenses, hasSignableManager };
}

/**
 * 載入「這個物件能建哪些案件」的事實。只看目前組織自己的節點與案件。
 * 呼叫端先確認物件屬於目前組織（`getProperty` 讀得到）。
 */
export async function loadCaseEntryFacts(
  tx: OrgTx,
  rc: { orgId: string; orgKind: OrgKind },
  property: EntryProperty,
  now: Date = new Date(),
): Promise<CaseEntryFacts> {
  const verified = canCreateCase(await getOwnershipGate(tx, property.rental_unit_id));
  const practice = rc.orgKind === 'practice' ? await loadPracticeEligibility(tx, now) : null;
  return {
    orgId: rc.orgId,
    orgKind: rc.orgKind,
    verified,
    practice,
    masterLeaseCase: verified && rc.orgKind === 'practice' ? await findCoveringMasterLeaseCase(tx, property.rental_unit_id) : null,
    mandateCase: verified && rc.orgKind === 'practice' ? await findCoveringMandateCase(tx, property.id) : null,
  };
}

/** 物件能建的案件種類。未核對是空陣列。 */
export async function listAvailableCaseKinds(
  tx: OrgTx,
  rc: { orgId: string; orgKind: OrgKind },
  property: EntryProperty,
  now: Date = new Date(),
): Promise<NewLeaseCaseKind[]> {
  return availableCaseKinds(await loadCaseEntryFacts(tx, rc, property, now));
}

export interface CreateCaseFromPropertyInput {
  orgId: string;
  orgKind: OrgKind;
  lessorPartyId: string;
  property: EntryProperty;
  caseKind: NewLeaseCaseKind;
}

/**
 * 依案件種類建立案件（MIL-209）。回傳案件 ID。
 * 所有檢查都在這裡重做，不信任呼叫端：
 * - 物件未核對：`createLeaseCase` 最前面丟 `property_not_verified`。
 * - 組織種類與案件種類的對應、執業主體的業別與專任管理人員：`decideCaseCreation`，事實由這裡載入。
 * - 轉租案件的包租案件、代管的租賃案件的委託管理案件：這裡只用目前組織自己的案件查，呼叫端不能傳入。
 * 被擋下時丟 `CaseCreationBlocked`，什麼都還沒寫。
 */
export async function createCaseFromProperty(tx: OrgTx, input: CreateCaseFromPropertyInput, now: Date = new Date()): Promise<string> {
  const businessType = businessTypeForNewCase(input.orgKind, input.caseKind);
  // 組織種類不能建這種案件：businessType 傳這種案件預期的值，讓 decideCaseCreation 回 host_org_not_allowed
  const resolvedBusinessType: BusinessType = businessType ?? (input.caseKind === 'sublease' ? 'master_lease' : 'self_managed');
  const practice = input.orgKind === 'practice' ? practiceFactsFor(input.caseKind, await loadPracticeEligibility(tx, now)) : null;
  const mandateCase =
    input.caseKind === 'lease' && input.orgKind === 'practice' ? await findCoveringMandateCase(tx, input.property.id) : null;
  return createLeaseCase(
    tx,
    {
      orgId: input.orgId,
      orgKind: input.orgKind,
      businessType: resolvedBusinessType,
      caseKind: input.caseKind,
      lessorPartyId: input.lessorPartyId,
      practice,
      mandateCase,
      linkedMandateCaseId: mandateCase?.id ?? null,
      property: input.property,
    },
    now,
  );
}
