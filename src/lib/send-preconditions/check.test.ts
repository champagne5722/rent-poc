import { describe, expect, it } from 'vitest';
import type { CredentialFacts } from '../credential-status';
import type { LeasingAuthoritySendFacts } from '../leasing-authority/preconditions';
import type { RoutingFacts } from '../signature-routing';
import {
  checkSendPreconditions,
  type AssignedPractitionerFacts,
  type SendPreconditionFacts,
  type SeatSigner,
} from './check';

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

function practitioner(patch: Partial<AssignedPractitionerFacts> = {}): AssignedPractitionerFacts {
  return {
    practitionerId: 'pr-chen',
    accountEmail: 'chen@beichen.example.com',
    certificateKind: 'rental_housing_manager',
    fullTime: true,
    isResponsiblePerson: false,
    employmentEntityId: 'org-a',
    credential: GOOD_CREDENTIAL,
    ...patch,
  };
}

const TENANT: SeatSigner = { seatRuleId: 'lease.master_lease.party_b', name: '王租客', email: 'tenant@example.com' };
const LESSOR: SeatSigner = { seatRuleId: 'lease.master_lease.party_a', name: '王建國', email: 'wang@beichen.example.com' };

function practitionerSigner(patch: Partial<AssignedPractitionerFacts> = {}, email?: string): SeatSigner {
  const p = practitioner(patch);
  return {
    seatRuleId: 'lease.master_lease.practitioner',
    name: '陳怡君',
    email: email ?? p.accountEmail,
    practitioner: p,
  };
}

function facts(patch: Partial<SendPreconditionFacts> = {}): SendPreconditionFacts {
  return {
    routing: MASTER_LEASE,
    at: AT,
    entities: { party_a: 'org-a' },
    registryAvailable: true,
    signers: [TENANT, practitionerSigner(), LESSOR],
    ...patch,
  };
}

const codes = (f: SendPreconditionFacts) => checkSendPreconditions(f).reasons.map((r) => r.code);

describe('checkSendPreconditions：ADR-0018 決議 10 的 7 項', () => {
  it('全部符合：可送簽，沒有原因', () => {
    expect(checkSendPreconditions(facts())).toEqual({ ok: true, reasons: [], notices: [] });
  });

  describe('第 1 項：規則表有定義這個組合', () => {
    it('未定義的組合被擋下，原因說明是哪個組合', () => {
      const result = checkSendPreconditions(
        facts({ routing: { documentType: 'lease', caseKind: 'management', brokerMediated: false }, signers: [] }),
      );
      expect(result.ok).toBe(false);
      expect(result.reasons.map((r) => r.code)).toEqual(['no_rule']);
    });
    it('不送簽的組合（自管點交證明）回報不需簽署', () => {
      expect(codes(facts({ routing: { documentType: 'handover_certificate', caseKind: 'lease', businessType: 'self_managed' }, signers: [] }))).toEqual([
        'not_required',
      ]);
    });
  });

  describe('第 2 項：規則要求執業人員時，合約有指派執業人員（ADR-0021 過渡條件）', () => {
    it('缺少執業人員：被擋下（P0-10 AC2）', () => {
      const result = checkSendPreconditions(facts({ signers: [TENANT, LESSOR] }));
      expect(result.ok).toBe(false);
      expect(result.reasons).toEqual([
        expect.objectContaining({ code: 'practitioner_not_assigned', seatRuleId: 'lease.master_lease.practitioner' }),
      ]);
      expect(result.reasons[0].message).toBe('尚未指派執業人員（租賃住宅管理人員）');
    });
    it('沒有選定執業主體：被擋下', () => {
      expect(codes(facts({ entities: {} }))).toContain('entity_not_selected');
    });
    it('規則不要求執業人員的組合（自管、代管租賃）不需要指派', () => {
      const selfManaged: RoutingFacts = { documentType: 'lease', caseKind: 'lease', businessType: 'self_managed', brokerMediated: false };
      const result = checkSendPreconditions({
        routing: selfManaged,
        at: AT,
        entities: {},
        registryAvailable: true,
        signers: [
          { seatRuleId: 'lease.self_managed.party_b', name: '王租客', email: 'tenant@example.com' },
          { seatRuleId: 'lease.self_managed.party_a', name: '林房東', email: 'landlord@example.com' },
        ],
      });
      expect(result.ok).toBe(true);
    });
    it('代管的租賃合約不產生執業人員（P0-12 AC2）', () => {
      const managed: RoutingFacts = { documentType: 'lease', caseKind: 'lease', businessType: 'managed', brokerMediated: false };
      const result = checkSendPreconditions({
        routing: managed,
        at: AT,
        entities: {},
        registryAvailable: false,
        signers: [
          { seatRuleId: 'lease.managed.party_b', name: '王租客', email: 'tenant@example.com' },
          { seatRuleId: 'lease.managed.party_a', name: '林屋主', email: 'owner@example.com' },
        ],
      });
      expect(result).toMatchObject({ ok: true, reasons: [] });
    });
  });

  describe('正式環境沒有真實 adapter（ADR-0021）', () => {
    it('規則要求執業人員的組合被擋下，原因是登錄資料來源未設定', () => {
      const result = checkSendPreconditions(facts({ registryAvailable: false, signers: [TENANT, LESSOR] }));
      expect(result.reasons.map((r) => r.code)).toEqual(['registry_unavailable']);
    });
    it('即使帶了執業人員也一樣擋下', () => {
      expect(codes(facts({ registryAvailable: false }))).toEqual(['registry_unavailable']);
    });
  });

  describe('第 3 項：credentialStatusAt 為可簽章', () => {
    it('證書已失效：被擋下，原因說明哪一層', () => {
      const credential: CredentialFacts = { ...GOOD_CREDENTIAL, practitioner: { ...GOOD_CREDENTIAL.practitioner, state: 'lapsed' } };
      const result = checkSendPreconditions(facts({ signers: [TENANT, practitionerSigner({ credential }), LESSOR] }));
      expect(result.reasons).toEqual([
        expect.objectContaining({ code: 'credential_not_signable', seatRuleId: 'lease.master_lease.practitioner' }),
      ]);
      expect(result.reasons[0].message).toBe('陳怡君：證書已失效');
    });
    it('多層同時不符：原因全部列出', () => {
      const credential: CredentialFacts = {
        license: { ...GOOD_CREDENTIAL.license, state: 'pending' },
        practitioner: { ...GOOD_CREDENTIAL.practitioner, validUntil: '2026-01-01' },
        employment: { ...GOOD_CREDENTIAL.employment, endsOn: '2026-10-01' },
      };
      const result = checkSendPreconditions(facts({ signers: [TENANT, practitionerSigner({ credential }), LESSOR] }));
      expect(result.reasons).toHaveLength(3);
      expect(result.reasons.map((r) => r.message)).toEqual([
        '陳怡君：業別待驗證',
        '陳怡君：證書已於 2026-01-01 期滿',
        '陳怡君：任職已於 2026-10-01 結束',
      ]);
    });
    it('換證窗口內仍得送簽，並附上換證期限', () => {
      const credential: CredentialFacts = { ...GOOD_CREDENTIAL, practitioner: { ...GOOD_CREDENTIAL.practitioner, validUntil: '2027-02-09' } };
      const result = checkSendPreconditions(facts({ signers: [TENANT, practitionerSigner({ credential }), LESSOR] }));
      expect(result.ok).toBe(true);
      expect(result.notices).toEqual([
        {
          code: 'renewal_window',
          seatRuleId: 'lease.master_lease.practitioner',
          validUntil: '2027-02-09',
          message: '陳怡君的證書將於 2027-02-09 期滿，請於期滿前換證',
        },
      ]);
    });
    it('判定用傳入的時點，不讀系統時間', () => {
      const credential: CredentialFacts = { ...GOOD_CREDENTIAL, practitioner: { ...GOOD_CREDENTIAL.practitioner, validUntil: '2026-11-09' } };
      const signers = [TENANT, practitionerSigner({ credential }), LESSOR];
      expect(checkSendPreconditions(facts({ signers, at: '2026-11-09T09:00:00+08:00' })).ok).toBe(true);
      expect(checkSendPreconditions(facts({ signers, at: '2026-11-10T09:00:00+08:00' })).ok).toBe(false);
    });
  });

  describe('第 4 項：證書種類與專任要求', () => {
    it('專任旗標為否：被拒（P0-12 AC4）', () => {
      const result = checkSendPreconditions(facts({ signers: [TENANT, practitionerSigner({ fullTime: false }), LESSOR] }));
      expect(result.reasons).toEqual([expect.objectContaining({ code: 'not_full_time' })]);
      expect(result.reasons[0].message).toBe('陳怡君不是專任，不可擔任專任管理人員');
    });
    it('負責人但沒有管理人員證書：被拒（P0-12 AC5）', () => {
      const result = checkSendPreconditions(
        facts({ signers: [TENANT, practitionerSigner({ certificateKind: null, isResponsiblePerson: true }), LESSOR] }),
      );
      expect(result.reasons).toEqual([expect.objectContaining({ code: 'certificate_missing' })]);
      expect(result.reasons[0].message).toBe('陳怡君是負責人，但沒有租賃住宅管理人員證書');
    });
    it('沒有證書的非負責人：同樣被拒，說明不提負責人', () => {
      const result = checkSendPreconditions(facts({ signers: [TENANT, practitionerSigner({ certificateKind: null }), LESSOR] }));
      expect(result.reasons[0].message).toBe('陳怡君沒有租賃住宅管理人員證書');
    });
    it('經紀營業員不得簽章（P0-12 規則 7）', () => {
      const result = checkSendPreconditions(
        facts({ signers: [TENANT, practitionerSigner({ certificateKind: 'real_estate_sales_agent' }), LESSOR] }),
      );
      expect(result.reasons).toEqual([expect.objectContaining({ code: 'certificate_kind_not_allowed' })]);
      expect(result.reasons[0].message).toBe('陳怡君是不動產經紀營業員，不得簽章');
    });
    it('證書種類不是這個席位要的（經紀人簽管理人員席位）：被拒', () => {
      const result = checkSendPreconditions(
        facts({ signers: [TENANT, practitionerSigner({ certificateKind: 'real_estate_broker' }), LESSOR] }),
      );
      expect(result.reasons[0]).toMatchObject({ code: 'certificate_kind_not_allowed' });
      expect(result.reasons[0].message).toBe('陳怡君的證書種類（不動產經紀人）不符合租賃住宅管理人員席位的要求');
    });
    it('經紀人席位不要求專任', () => {
      const broker: RoutingFacts = { documentType: 'lease', caseKind: 'sublease', brokerMediated: true };
      const brokerSigner: SeatSigner = {
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
      };
      const result = checkSendPreconditions(
        facts({
          routing: broker,
          entities: { party_a: 'org-a', broker_entity: 'org-b' },
          signers: [TENANT, practitionerSigner(), LESSOR, brokerSigner],
        }),
      );
      expect(result).toMatchObject({ ok: true, reasons: [] });
    });
  });

  describe('第 5 項：任職屬於規則指定的執業主體', () => {
    it('任職所屬的執業主體與席位指定的不同：被擋下', () => {
      const result = checkSendPreconditions(facts({ signers: [TENANT, practitionerSigner({ employmentEntityId: 'org-x' }), LESSOR] }));
      expect(result.reasons).toEqual([expect.objectContaining({ code: 'employment_entity_mismatch' })]);
    });
    it('席位指定的是乙方執業主體時，比對乙方的執業主體', () => {
      const reversed: RoutingFacts = { documentType: 'lease', caseKind: 'master_lease', brokerMediated: false };
      const result = checkSendPreconditions({
        routing: reversed,
        at: AT,
        entities: { party_b: 'org-a' },
        registryAvailable: true,
        signers: [
          { seatRuleId: 'lease.self_managed_lessee_master_lessor.party_a', name: '林房東', email: 'landlord@example.com' },
          { ...practitionerSigner(), seatRuleId: 'lease.self_managed_lessee_master_lessor.practitioner' },
          { seatRuleId: 'lease.self_managed_lessee_master_lessor.party_b', name: '王建國', email: 'wang@beichen.example.com' },
        ],
      });
      expect(result).toMatchObject({ ok: true, reasons: [] });
    });
  });

  describe('第 6 項：執業人員的 email 取自其帳號', () => {
    it('email 與帳號不同：被擋下', () => {
      const result = checkSendPreconditions(facts({ signers: [TENANT, practitionerSigner({}, 'other@example.com'), LESSOR] }));
      expect(result.reasons).toEqual([expect.objectContaining({ code: 'email_not_from_account' })]);
    });
    it('大小寫與前後空白不算不同', () => {
      const result = checkSendPreconditions(
        facts({ signers: [TENANT, practitionerSigner({}, '  Chen@Beichen.example.com '), LESSOR] }),
      );
      expect(result.ok).toBe(true);
    });
  });

  describe('第 7 項：email 不重複', () => {
    it('執業人員與當事人簽署人是同一人：被擋下（兼任合併屬 MIL-76）', () => {
      const result = checkSendPreconditions(
        facts({ signers: [TENANT, practitionerSigner(), { ...LESSOR, email: 'chen@beichen.example.com' }] }),
      );
      expect(result.reasons).toEqual([expect.objectContaining({ code: 'duplicate_email' })]);
      expect(result.reasons[0].message).toBe('簽署人的 email 重複：chen@beichen.example.com（執業人員、甲方）');
    });
    it('執業人員同時是相對人：被擋下', () => {
      const result = checkSendPreconditions(
        facts({ signers: [{ ...TENANT, email: 'Chen@beichen.example.com' }, practitionerSigner(), LESSOR] }),
      );
      expect(result.reasons.map((r) => r.code)).toEqual(['duplicate_email']);
    });
    it('兩人共用信箱：被擋下', () => {
      const result = checkSendPreconditions(facts({ signers: [TENANT, practitionerSigner(), { ...LESSOR, email: 'tenant@example.com' }] }));
      expect(result.reasons.map((r) => r.code)).toEqual(['duplicate_email']);
    });
  });

  it('多項同時不符：全部列出，順序依檢查項目', () => {
    const credential: CredentialFacts = { ...GOOD_CREDENTIAL, practitioner: { ...GOOD_CREDENTIAL.practitioner, state: 'lapsed' } };
    const result = checkSendPreconditions(
      facts({
        signers: [
          TENANT,
          practitionerSigner({ credential, fullTime: false, employmentEntityId: 'org-x' }, 'other@example.com'),
          { ...LESSOR, email: 'tenant@example.com' },
        ],
      }),
    );
    expect(result.reasons.map((r) => r.code)).toEqual([
      'credential_not_signable',
      'not_full_time',
      'employment_entity_mismatch',
      'email_not_from_account',
      'duplicate_email',
    ]);
  });

  describe('併入出租權源的送簽前提（B 線 MIL-150）', () => {
    const noAuthority: LeasingAuthoritySendFacts = {
      rentalUnitId: 'ru-1',
      primaryAuthority: null,
      propertyNotVerified: false,
      hasPendingSuspectedDuplicate: false,
    };
    it('權源的原因接在後面，全部列給使用者', () => {
      const result = checkSendPreconditions(facts({ signers: [TENANT, LESSOR], leasingAuthority: noAuthority }));
      expect(result.reasons.map((r) => r.code)).toEqual(['practitioner_not_assigned', 'no_primary_authority']);
    });
    it('沒有帶權源事實時不檢查', () => {
      expect(codes(facts())).toEqual([]);
    });
    it('主要出租權源待驗證時擋下送簽，不再產生「出租權源未驗證」的告知（MIL-205）', () => {
      const pending: LeasingAuthoritySendFacts = {
        rentalUnitId: 'ru-1',
        primaryAuthority: {
          id: 'au-1',
          kind: 'ownership',
          status: 'pending_verification',
          providedDocuments: ['registry_transcript', 'transcript_obtained_at'],
          trust: { registered: false },
        },
        propertyNotVerified: false,
        hasPendingSuspectedDuplicate: false,
      };
      const result = checkSendPreconditions(facts({ leasingAuthority: pending }));
      expect(result.ok).toBe(false);
      expect(result.reasons.map((r) => r.code)).toEqual(['primary_authority_pending']);
      expect(result).not.toHaveProperty('leasingAuthorityFacts');
    });
  });
});
