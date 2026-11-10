import { appendAudit } from '../audit';
import {
  buildCaseEvent,
  decideCaseCreation,
  isTenantRelation,
  type BusinessType,
  type CaseMemberRelation,
  type CreationBlockReason,
  type MandateCaseFacts,
  type NewLeaseCaseKind,
  type OrgKind,
  type PracticeFacts,
} from '../cases';
import { resolveSocialHousingDefault } from '../case-ledger/social-housing-default';
import {
  canCreateCase,
  PROPERTY_NOT_VERIFIED_CODE,
  PROPERTY_NOT_VERIFIED_MESSAGE,
} from '../ownership/gate';
import { getOwnershipGate } from '../ownership/repository';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import {
  closeMemberPeriod,
  findCoveringMasterLeaseCase,
  findOrCreateParty,
  insertCase,
  insertCaseEvent,
  insertCaseMember,
  isEmailActiveMember,
  lockMemberForReplacement,
  normalizePartyEmail,
  setCurrentContract,
} from './repository';
import type { CaseActor } from './types';

// 案件的建立、掛合約與加成員（MIL-115）。轉移不在這裡，一律走 dispatch()。
// 全部用呼叫端的 tx，與合約的寫入同一個交易。權限由呼叫端先 authorize()。

/** 物件沒有通過平台的文件核對（MIL-205，ADR-0028 決議 5）。不屬於 `decideCaseCreation` 的原因碼。 */
export interface PropertyNotVerifiedReason {
  code: typeof PROPERTY_NOT_VERIFIED_CODE;
  message: typeof PROPERTY_NOT_VERIFIED_MESSAGE;
}

export type CaseCreationBlockReason = CreationBlockReason | PropertyNotVerifiedReason;

/** 建立案件被擋下。`reasons` 是全部原因：`decideCaseCreation` 的原因，或物件沒有通過核對。 */
export class CaseCreationBlocked extends Error {
  constructor(readonly reasons: CaseCreationBlockReason[]) {
    super(reasons.map((r) => r.message).join(' '));
    this.name = 'CaseCreationBlocked';
  }
}

export interface NewLeaseCaseInput {
  orgId: string;
  orgKind: OrgKind;
  /** 舊欄位。`master_lease` 是舊值，指轉租案件（見 src/lib/cases/case-kind.ts）。 */
  businessType: BusinessType;
  /**
   * 案件種類（ADR-0030）。不傳時：業務類型 `master_lease` 當轉租案件，其餘當租賃案件。
   * 包租案件（屋主租給包租業者）由包租業者的組織建立，必須明傳 `master_lease`，業務類型傳 `self_managed`。
   */
  caseKind?: NewLeaseCaseKind;
  /**
   * 過渡用，MIL-203 移除。舊建約精靈（POST /api/contracts）由屋主組織建立自管案件，
   * 分流條件說承租人是包租業者時傳 true，案件歸為包租案件。新的建立入口不得傳這個欄位。
   */
  lesseeIsMasterLessor?: boolean;
  /** 租賃案件是出租人（建約的使用者），代管是屋主，包租案件是屋主，轉租案件是包租業者。 */
  lessorPartyId: string;
  /** 只用於轉租案件：屋主（包租案件的出租人）。 */
  ownerPartyId?: string | null;
  brokerPartyId?: string | null;
  /** 主辦組織是執業主體組織時必須傳，由呼叫端查好業別與專任管理人員的事實。 */
  practice?: PracticeFacts | null;
  /** 代管案件必須傳。 */
  mandateCase?: MandateCaseFacts | null;
  property: { id: string; name: string; address: string; rental_unit_id: string };
  /**
   * 社宅代管案件旗標（ADR-0050 決議 10）。不傳或傳 null 時，有委託管理案件就帶入它的旗標，否則是 false。
   * 自管案件沒有代管業者，旗標一律 false。事後修改走 changeSocialHousing。
   */
  socialHousing?: boolean | null;
  /** 代管案件連到的委託管理案件。目前只用來決定社宅旗標的預設值，案件欄位由 MIL-116 寫入。 */
  linkedMandateCaseId?: string | null;
}

/**
 * 建立租賃、包租或轉租案件（建約 wizard 第一步，ADR-0023 決議 1，ADR-0030 決議 1、5），回傳案件 ID。
 * 委託管理案件不在這裡建，見 `decideCaseCreation` 的 `new_management`。
 * 案件、出租人成員、`created` 事件與稽核事件在同一個交易。
 *
 * 誰能呼叫：已在 `inOrgTx` 內、並已 authorize() 的 route。這個函式不做權限判斷。
 * 轉租案件的包租案件事實由這裡自己查（`findCoveringMasterLeaseCase`），呼叫端不能傳入，所以無法偽造。
 * 查詢只看目前組織主辦的案件。找不到時丟 `CaseCreationBlocked`，說明不分「沒有」與「別的組織的」。
 * 物件沒有通過平台的文件核對時，在最前面丟 `CaseCreationBlocked`（`property_not_verified`），見 `requireVerifiedProperty`。
 */
export async function createLeaseCase(tx: OrgTx, input: NewLeaseCaseInput, now: Date = new Date()): Promise<string> {
  await requireVerifiedProperty(tx, input.property.rental_unit_id);
  const caseId = newUlid();
  const legacyMasterLease =
    input.caseKind === undefined && input.lesseeIsMasterLessor === true && input.businessType === 'self_managed';
  const caseKind: NewLeaseCaseKind | undefined = legacyMasterLease ? 'master_lease' : input.caseKind;
  const resolvedKind = caseKind ?? (input.businessType === 'master_lease' ? 'sublease' : 'lease');
  const masterLeaseCase =
    resolvedKind === 'sublease' ? await findCoveringMasterLeaseCase(tx, input.property.rental_unit_id) : null;
  const result = decideCaseCreation(
    {
      type: 'new_lease',
      caseId,
      rentalUnitId: input.property.rental_unit_id,
      hostOrg: { orgId: input.orgId, kind: input.orgKind },
      caseKind,
      businessType: input.businessType,
      lessorPartyId: input.lessorPartyId,
      ownerPartyId: input.ownerPartyId ?? null,
      brokerPartyId: input.brokerPartyId ?? null,
      practice: input.practice ?? null,
      mandateCase: input.mandateCase ?? null,
      masterLeaseCase,
      transitionalOwnerHosted: legacyMasterLease && input.orgKind === 'owner',
    },
    now,
  );
  if (!result.ok) throw new CaseCreationBlocked(result.reasons);

  const socialHousing =
    input.businessType === 'self_managed'
      ? false
      : (input.socialHousing ?? (await resolveSocialHousingDefault(tx, input.linkedMandateCaseId ?? null)));
  await insertCase(
    tx,
    result.case,
    {
      title: caseTitleOf(input.property),
      propertyId: input.property.id,
      rentalUnitId: input.property.rental_unit_id,
      socialHousing,
    },
    now,
  );
  for (const member of result.members) await insertCaseMember(tx, caseId, member, now);
  await insertCaseEvent(tx, caseId, { event: result.event, toState: result.case.state, actorPartyId: input.lessorPartyId });
  // payload 不放姓名、地址、租金：canonical 寫入後刪不掉（ADR-0019 決議 5）
  await appendAudit(tx, {
    action: 'case.create',
    object: { type: 'case', id: caseId },
    payload: { kind: 'lease', case_kind: result.case.caseKind, business_type: input.businessType },
  });
  return caseId;
}

/**
 * 物件通過核對後才能建立案件（MIL-205，ADR-0028 決議 5）。
 * 由這裡自己查這個組織對這個租賃單位有沒有已驗證的所有權節點，呼叫端不能傳入結果，所以無法偽造。
 * 別的組織的租賃單位、不存在的租賃單位與沒有節點的結果相同，原因文字固定，不洩漏物件在不在平台上。
 * 放在 `createLeaseCase` 的最前面：被擋下時什麼都還沒寫。
 */
async function requireVerifiedProperty(tx: OrgTx, rentalUnitId: string): Promise<void> {
  const gate = await getOwnershipGate(tx, rentalUnitId);
  if (!canCreateCase(gate)) {
    throw new CaseCreationBlocked([{ code: PROPERTY_NOT_VERIFIED_CODE, message: PROPERTY_NOT_VERIFIED_MESSAGE }]);
  }
}

/** 案件清單顯示的名稱：物件名稱加地址。 */
export function caseTitleOf(property: { name: string; address: string }): string {
  const name = property.name.trim();
  const address = property.address.trim();
  return name && address ? `${name}（${address}）` : name || address;
}

/**
 * 案件的目前合約改指向這份合約，並寫 `contract_attached` 事件。
 * 建案件時掛第一份草稿，撤回或拒簽後複製的新草稿也留在同一案件（P0-09 AC7、ADR-0016 決議 12）。
 */
export async function attachContract(
  tx: OrgTx,
  caseId: string,
  contractId: string,
  options: { now?: Date; actor?: CaseActor; derivedFrom?: string | null } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  await setCurrentContract(tx, caseId, contractId, now);
  await insertCaseEvent(tx, caseId, {
    event: buildCaseEvent('contract_attached', now, { contractId, derivedFrom: options.derivedFrom ?? null }),
    actorPartyId: options.actor?.partyId ?? null,
  });
}

/**
 * 加入案件成員。同一人同一關係已有效時不重複，回傳 false。新增時寫 `member_added` 事件與稽核事件。
 * 事件與稽核 payload 只放 ID 與關係，不放 email 與姓名。
 */
export async function addCaseMember(
  tx: OrgTx,
  caseId: string,
  member: { partyId: string; relation: CaseMemberRelation },
  options: { now?: Date; actor?: CaseActor } = {},
): Promise<boolean> {
  const now = options.now ?? new Date();
  const added = await insertCaseMember(tx, caseId, member, now);
  if (!added) return false;
  await insertCaseEvent(tx, caseId, {
    event: buildCaseEvent('member_added', now, { relation: member.relation, partyId: member.partyId }),
    actorPartyId: options.actor?.partyId ?? null,
  });
  await appendAudit(tx, {
    action: 'case_member.add',
    object: { type: 'case', id: caseId },
    payload: { relation: member.relation, party_id: member.partyId },
  });
  return true;
}

export type ReplaceMemberEmailResult =
  | { ok: true; newPartyId: string; relation: CaseMemberRelation }
  /** member_not_found：案件下沒有這個成員。not_active：這一列已結束。not_tenant：不是承租人或共同承租人。
   *  same_email：新 email 與目前相同。already_member：新 email 已是同案件的有效成員。 */
  | { ok: false; reason: 'member_not_found' | 'not_active' | 'not_tenant' | 'same_email' | 'already_member' };

/**
 * 更新承租人或共同承租人的 email（MIL-121，ADR-0023 決議 5，P0-21 AC5）。呼叫端先 authorize(case_member.manage)。
 *
 * 不改 control.parties.email：party 是跨組織的自然人，改它會動到這個人在其他案件的身分。
 * 做法是關閉舊成員列的 valid_period（不刪列），以新 email 找或建 party，加一列新的成員，關係沿用原本的。
 * 關閉用資料庫的 now()，與讀取政策同一個時鐘，舊 email 的下一個請求就失去成員資格。
 * 全部檢查通過才寫入，檢查不過什麼都不改。合約內的乙方 email 不改（合約不可變，ADR-0006）。
 * 事件與稽核的 payload 只放 ID 與關係，不放 email（canonical 寫入後刪不掉，ADR-0019 決議 5）。
 */
export async function replaceTenantMemberEmail(
  tx: OrgTx,
  caseId: string,
  memberId: string,
  input: { email: string; displayName?: string },
  options: { now?: Date; actor?: CaseActor } = {},
): Promise<ReplaceMemberEmailResult> {
  const now = options.now ?? new Date();
  const old = await lockMemberForReplacement(tx, caseId, memberId);
  if (!old) return { ok: false, reason: 'member_not_found' };
  if (!isTenantRelation(old.relation)) return { ok: false, reason: 'not_tenant' };
  if (!old.active) return { ok: false, reason: 'not_active' };

  const email = normalizePartyEmail(input.email);
  if (!email) throw new Error('email 格式不正確');
  if (email === old.email) return { ok: false, reason: 'same_email' };
  if (await isEmailActiveMember(tx, caseId, email)) return { ok: false, reason: 'already_member' };

  const newPartyId = await findOrCreateParty(tx, email, input.displayName?.trim() || old.displayName);
  // 先加新列再關舊列：加入被唯一索引擋下（並行的請求搶先加了同一個人）時，回 already_member，舊列原封不動。
  // 成員列在上面已 FOR UPDATE 鎖住，同一列的並行更新會排隊，後到的看到 not_active
  const added = await insertCaseMember(tx, caseId, { partyId: newPartyId, relation: old.relation }, now);
  if (!added) return { ok: false, reason: 'already_member' };
  await closeMemberPeriod(tx, memberId);
  await insertCaseEvent(tx, caseId, {
    event: buildCaseEvent('member_replaced', now, { relation: old.relation, fromPartyId: old.partyId, toPartyId: newPartyId }),
    actorPartyId: options.actor?.partyId ?? null,
  });
  await appendAudit(tx, {
    action: 'case_member.replace_email',
    object: { type: 'case', id: caseId },
    payload: { relation: old.relation, from_party_id: old.partyId, to_party_id: newPartyId },
  });
  return { ok: true, newPartyId, relation: old.relation };
}
