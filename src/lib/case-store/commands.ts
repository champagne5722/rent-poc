import { appendAudit } from '../audit';
import {
  buildCaseEvent,
  decideCaseCreation,
  isTenantRelation,
  type BusinessType,
  type CaseMemberRelation,
  type CreationBlockReason,
  type OrgKind,
} from '../cases';
import { resolveSocialHousingDefault } from '../case-ledger/social-housing-default';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import {
  closeMemberPeriod,
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

/** `decideCaseCreation` 擋下了建立。`reasons` 是全部原因。 */
export class CaseCreationBlocked extends Error {
  constructor(readonly reasons: CreationBlockReason[]) {
    super(reasons.map((r) => r.message).join(' '));
    this.name = 'CaseCreationBlocked';
  }
}

export interface NewLeaseCaseInput {
  orgId: string;
  orgKind: OrgKind;
  businessType: BusinessType;
  /** 自管案件是出租人（建約的使用者），代管是屋主，包租是包租業者。 */
  lessorPartyId: string;
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
 * 建立租賃案件（建約 wizard 第一步，ADR-0023 決議 1），回傳案件 ID。
 * 本票只接自管：代管與包租需要業別與委託的事實，由 MIL-116 傳入 `decideCaseCreation`。
 * 案件、出租人成員、`created` 事件與稽核事件在同一個交易。
 */
export async function createLeaseCase(tx: OrgTx, input: NewLeaseCaseInput, now: Date = new Date()): Promise<string> {
  const caseId = newUlid();
  const result = decideCaseCreation(
    {
      type: 'new_lease',
      caseId,
      rentalUnitId: input.property.rental_unit_id,
      hostOrg: { orgId: input.orgId, kind: input.orgKind },
      businessType: input.businessType,
      lessorPartyId: input.lessorPartyId,
      ownerPartyId: null,
      brokerPartyId: null,
      practice: null,
      mandateCase: null,
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
    payload: { kind: 'lease', business_type: input.businessType },
  });
  return caseId;
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
