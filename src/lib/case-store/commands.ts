import { appendAudit } from '../audit';
import {
  buildCaseEvent,
  decideCaseCreation,
  type BusinessType,
  type CaseMemberRelation,
  type CreationBlockReason,
  type OrgKind,
} from '../cases';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import { insertCase, insertCaseEvent, insertCaseMember, setCurrentContract } from './repository';
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

  await insertCase(
    tx,
    result.case,
    {
      title: caseTitleOf(input.property),
      propertyId: input.property.id,
      rentalUnitId: input.property.rental_unit_id,
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
