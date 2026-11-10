import { describe, expect, it } from 'vitest';
import type { CredentialFacts } from '../credential-status';
import type { RoutingFacts } from '../signature-routing';
import { checkSendPreconditions, type AssignedPractitionerFacts, type SeatSigner, type SendPreconditionFacts } from './check';

// 第 7 項「合併後 email 不重複」（ADR-0018 決議 9、10，MIL-76）。
// 同一人兼任時，執業人員與當事人簽署人合併成一位，不算 email 重複。其他重複仍擋下。

const AT = '2026-11-09T12:00:00+08:00';

const GOOD_CREDENTIAL: CredentialFacts = {
  license: { state: 'verified', validUntil: null, latestCheckId: 'chk-l' },
  practitioner: { state: 'verified', validUntil: '2029-03-31', latestCheckId: 'chk-c' },
  employment: { state: 'verified', startsOn: '2025-01-01', endsOn: null, latestCheckId: 'chk-e' },
};

const MASTER_LEASE: RoutingFacts = {
  documentType: 'lease',
  caseKind: 'sublease',
  brokerMediated: false,
};
const BROKERED: RoutingFacts = { documentType: 'lease', caseKind: 'sublease', brokerMediated: true };

const CHEN = { partyId: 'party-chen', entityId: 'org-a' };
const CHEN_EMAIL = 'chen@beichen.example.com';

function practitioner(patch: Partial<AssignedPractitionerFacts> = {}): AssignedPractitionerFacts {
  return {
    practitionerId: 'pr-chen',
    accountEmail: CHEN_EMAIL,
    certificateKind: 'rental_housing_manager',
    fullTime: true,
    isResponsiblePerson: false,
    employmentEntityId: 'org-a',
    credential: GOOD_CREDENTIAL,
    ...patch,
  };
}

const TENANT: SeatSigner = { seatRuleId: 'lease.master_lease.party_b', name: '王租客', email: 'tenant@example.com' };
const MANAGER: SeatSigner = {
  seatRuleId: 'lease.master_lease.practitioner',
  name: '陳怡君',
  email: CHEN_EMAIL,
  practitioner: practitioner(),
  identity: CHEN,
};
const LESSOR_IS_CHEN: SeatSigner = {
  seatRuleId: 'lease.master_lease.party_a',
  name: '陳怡君',
  email: CHEN_EMAIL,
  identity: CHEN,
};
const BROKER: SeatSigner = {
  seatRuleId: 'lease.broker',
  name: '趙經紀',
  email: 'zhao@yunding.example.com',
  practitioner: practitioner({
    practitionerId: 'pr-zhao',
    accountEmail: 'zhao@yunding.example.com',
    certificateKind: 'real_estate_broker',
    fullTime: false,
    employmentEntityId: 'org-b',
  }),
  identity: { partyId: 'party-zhao', entityId: 'org-b' },
};

function facts(patch: Partial<SendPreconditionFacts> = {}): SendPreconditionFacts {
  return {
    routing: MASTER_LEASE,
    at: AT,
    entities: { party_a: 'org-a' },
    registryAvailable: true,
    signers: [TENANT, MANAGER, LESSOR_IS_CHEN],
    ...patch,
  };
}

const codes = (f: SendPreconditionFacts) => checkSendPreconditions(f).reasons.map((r) => r.code);

describe('checkSendPreconditions：同一人兼任合併後再檢查 email', () => {
  it('當事人簽署人與執業人員是同一人：合併，email 不算重複', () => {
    expect(checkSendPreconditions(facts())).toEqual({ ok: true, reasons: [], notices: [] });
  });

  it('居間加包租，兼任合併後仍可送簽', () => {
    const result = checkSendPreconditions(
      facts({ routing: BROKERED, entities: { party_a: 'org-a', broker_entity: 'org-b' }, signers: [TENANT, MANAGER, LESSOR_IS_CHEN, BROKER] }),
    );
    expect(result.ok).toBe(true);
  });

  it('合併的簽署人仍要通過執業人員的資格檢查', () => {
    const lapsed: CredentialFacts = { ...GOOD_CREDENTIAL, practitioner: { ...GOOD_CREDENTIAL.practitioner, state: 'lapsed' } };
    const bad = { ...MANAGER, practitioner: practitioner({ credential: lapsed }) };
    expect(codes(facts({ signers: [TENANT, bad, LESSOR_IS_CHEN] }))).toEqual(['credential_not_signable']);
  });

  it('同 email 但不是同一人（partyId 不同）：被擋下', () => {
    const other = { ...LESSOR_IS_CHEN, identity: { partyId: 'party-other', entityId: 'org-a' } };
    expect(codes(facts({ signers: [TENANT, MANAGER, other] }))).toEqual(['duplicate_email']);
  });

  it('partyId 相同但當事人簽署人不屬於同一執業主體：被擋下', () => {
    const elsewhere = { ...LESSOR_IS_CHEN, identity: { partyId: 'party-chen', entityId: 'org-other' } };
    expect(codes(facts({ signers: [TENANT, MANAGER, elsewhere] }))).toEqual(['duplicate_email']);
  });

  it('沒有身分資料：不合併，同 email 被擋下', () => {
    const { identity: _identity, ...noIdentity } = LESSOR_IS_CHEN;
    void _identity;
    expect(codes(facts({ signers: [TENANT, MANAGER, noIdentity] }))).toEqual(['duplicate_email']);
  });

  it('合併的簽署人又與相對人共用信箱：被擋下', () => {
    const tenant = { ...TENANT, email: CHEN_EMAIL };
    const result = checkSendPreconditions(facts({ signers: [tenant, MANAGER, LESSOR_IS_CHEN] }));
    expect(result.reasons.map((r) => r.code)).toEqual(['duplicate_email']);
    expect(result.reasons[0].message).toBe('簽署人的 email 重複：chen@beichen.example.com（乙方、執業人員）');
  });

  it('執業人員同時是相對人（乙方）：不是執業主體的當事人，不合併，被擋下', () => {
    const tenant = { ...TENANT, email: CHEN_EMAIL, identity: CHEN };
    const lessor = { ...LESSOR_IS_CHEN, email: 'wang@beichen.example.com', identity: { partyId: 'party-wang', entityId: 'org-a' } };
    expect(codes(facts({ signers: [tenant, MANAGER, lessor] }))).toEqual(['duplicate_email']);
  });

  it('經紀人與包租的執業人員共用信箱：被擋下', () => {
    const broker = { ...BROKER, email: CHEN_EMAIL, practitioner: { ...BROKER.practitioner!, accountEmail: CHEN_EMAIL } };
    expect(
      codes(
        facts({
          routing: BROKERED,
          entities: { party_a: 'org-a', broker_entity: 'org-b' },
          signers: [TENANT, MANAGER, LESSOR_IS_CHEN, broker],
        }),
      ),
    ).toEqual(['duplicate_email']);
  });
});
