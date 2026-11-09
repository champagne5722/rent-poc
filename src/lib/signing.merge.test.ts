import { describe, expect, it } from 'vitest';
import type { RoutingFacts, SeatAssignee, SeatIdentity } from './signature-routing';
import { prepareContractSigners } from './signing';
import type { LeaseContract, SignatureField } from './types';

// 同一人兼任時，送簽的簽署序列合併成一位簽署人（MIL-76）。

const MASTER_LEASE: RoutingFacts = { documentType: 'lease', businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: false };
const BROKERED: RoutingFacts = { ...MASTER_LEASE, brokerMediated: true } as RoutingFacts;

const field = (id: string, signer: SignatureField['signer'], slot: string, page = 0): SignatureField => ({
  id,
  signer,
  slot,
  page,
  x: 0.1,
  y: 0.8,
  w: 0.2,
  h: 0.1,
});

const B = field('b', 'party_b', 'lease.master_lease.party_b');
const P = field('p', 'practitioner', 'lease.master_lease.practitioner');
const A = field('a', 'party_a', 'lease.master_lease.party_a');
const K = field('k', 'practitioner', 'lease.broker');

function contract(signatureFields: SignatureField[]): LeaseContract {
  return {
    id: 1,
    property_id: null,
    contract_type: 'lease',
    status: 'draft',
    fields: {
      landlordName: '陳怡君',
      landlordEmail: 'chen.yijun@beichen.example.com',
      tenantName: '王租客',
      tenantEmail: 'tenant@example.com',
      propertyName: '測試物件',
      propertyAddress: '台北市測試路 1 號',
      propertyType: '套房',
      propertySize: 10,
      equipmentAnnex: [],
      rent: 15000,
      deposit: 30000,
      startDate: '2026-09-01',
      endDate: '2027-08-31',
      payDay: 5,
      extra: '',
    },
    signature_fields: signatureFields,
    declined_reason: null,
    derived_from: null,
    created_at: '2026-08-01 00:00:00',
    updated_at: null,
  };
}

const CHEN: SeatIdentity = { partyId: 'party-chen', entityId: 'org-a' };
const manager: SeatAssignee = { name: '陳怡君', email: 'chen.yijun@beichen.example.com' };
const broker: SeatAssignee = { name: '趙經紀', email: 'zhao@yunding.example.com' };

describe('prepareContractSigners：同一人兼任', () => {
  const practitioners = { 'lease.master_lease.practitioner': manager };
  const identities = { 'lease.master_lease.practitioner': CHEN, 'lease.master_lease.party_a': CHEN };

  it('合併成兩位：乙方，以及帶兼任角色的執業人員，兩個席位的簽署區域都歸這位簽署人', () => {
    const result = prepareContractSigners(contract([B, P, A]), MASTER_LEASE, practitioners, identities);
    expect(result).toEqual({
      ok: true,
      signers: [
        { role: 'party_b', name: '王租客', email: 'tenant@example.com', verifyMethods: ['email'], signatureFields: [B] },
        {
          role: 'practitioner',
          name: '陳怡君',
          email: 'chen.yijun@beichen.example.com',
          concurrentRoles: ['party_a'],
          verifyMethods: ['email'],
          signatureFields: [P, A],
        },
      ],
    });
  });

  it('沒有傳身分資料：不合併，維持三位', () => {
    const result = prepareContractSigners(contract([B, P, A]), MASTER_LEASE, practitioners);
    expect(result.ok && result.signers.map((s) => s.role)).toEqual(['party_b', 'practitioner', 'party_a']);
  });

  it('合併後仍要求每個席位各有簽署區域：缺甲方的區域時指名甲方', () => {
    expect(prepareContractSigners(contract([B, P]), MASTER_LEASE, practitioners, identities)).toEqual({
      ok: false,
      status: 400,
      error: '請至少為甲方設定一個簽署區域',
    });
  });

  it('合併後仍要求執業人員席位有簽署區域：缺執業人員的區域時指名執業人員', () => {
    expect(prepareContractSigners(contract([B, A]), MASTER_LEASE, practitioners, identities)).toEqual({
      ok: false,
      status: 400,
      error: '請至少為執業人員設定一個簽署區域',
    });
  });
});

describe('prepareContractSigners：居間加包租的四位', () => {
  const practitioners = { 'lease.master_lease.practitioner': manager, 'lease.broker': broker };

  it('四位依序：乙方、專任管理人員、甲方、經紀人，兩位執業人員的簽署區域以席位區分', () => {
    const result = prepareContractSigners(contract([K, A, P, B]), BROKERED, practitioners);
    if (!result.ok) throw new Error(result.error);
    expect(result.signers.map((s) => [s.role, s.name])).toEqual([
      ['party_b', '王租客'],
      ['practitioner', '陳怡君'],
      ['party_a', '陳怡君'],
      ['practitioner', '趙經紀'],
    ]);
    expect(result.signers[1].signatureFields).toEqual([P]);
    expect(result.signers[3].signatureFields).toEqual([K]);
  });

  it('兼任合併加經紀人：三位，經紀人仍排在最後', () => {
    const result = prepareContractSigners(contract([B, P, A, K]), BROKERED, practitioners, {
      'lease.master_lease.practitioner': CHEN,
      'lease.master_lease.party_a': CHEN,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.signers.map((s) => [s.role, s.concurrentRoles ?? []])).toEqual([
      ['party_b', []],
      ['practitioner', ['party_a']],
      ['practitioner', []],
    ]);
  });

  it('經紀人沒有簽署區域：指名執業人員', () => {
    expect(prepareContractSigners(contract([B, P, A]), BROKERED, practitioners)).toEqual({
      ok: false,
      status: 400,
      error: '請至少為執業人員設定一個簽署區域',
    });
  });
});
