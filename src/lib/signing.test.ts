import { describe, expect, it } from 'vitest';
import type { Contract, ContractStatus } from './types';
import { contractDocumentFileName, prepareContractSigners } from './signing';
import type { RoutingFacts } from './signature-routing';
import { ulidOf } from './test-ids';

function makeContract(status: ContractStatus): Contract {
  return {
    id: ulidOf(1),
    property_id: null,
    contract_type: 'lease',
    status,
    fields: {
      landlordName: '林房東',
      landlordEmail: 'landlord@example.com',
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
    signature_fields: [],
    declined_reason: null,
    derived_from: null,
    created_at: '2026-08-01 00:00:00',
    updated_at: null,
  };
}

const SELF_MANAGED: RoutingFacts = {
  documentType: 'lease',
  businessType: 'self_managed',
  lesseeIsMasterLessor: false,
  brokerMediated: false,
};

describe('prepareContractSigners（送簽的簽署序列，來自規則表）', () => {
  it('自管租賃合約：乙方在前、甲方在後，各自帶自己的簽署區域', () => {
    const partyBField = { id: 'f1', signer: 'party_b', page: 0, x: 0.1, y: 0.8, w: 0.2, h: 0.1 } as const;
    const partyAField = { id: 'f2', signer: 'party_a', page: 1, x: 0.6, y: 0.8, w: 0.2, h: 0.1 } as const;
    const contract = { ...makeContract('draft'), signature_fields: [partyAField, partyBField] };

    expect(prepareContractSigners(contract, SELF_MANAGED)).toEqual({
      ok: true,
      signers: [
        { role: 'party_b', name: '王租客', email: 'tenant@example.com', verifyMethods: ['email'], signatureFields: [partyBField] },
        { role: 'party_a', name: '林房東', email: 'landlord@example.com', verifyMethods: ['email'], signatureFields: [partyAField] },
      ],
    });
  });

  it('缺少簽署區域時，依簽署順序回報第一個缺少的角色', () => {
    const partyAField = { id: 'f2', signer: 'party_a', page: 1, x: 0.6, y: 0.8, w: 0.2, h: 0.1 } as const;
    const contract = { ...makeContract('draft'), signature_fields: [partyAField] };
    expect(prepareContractSigners(contract, SELF_MANAGED)).toEqual({
      ok: false,
      status: 400,
      error: '請至少為乙方設定一個簽署區域',
    });
  });

  it('規則要求執業人員但合約沒有指派時擋下，不略過這位簽署人', () => {
    const facts: RoutingFacts = { ...SELF_MANAGED, businessType: 'master_lease' };
    expect(prepareContractSigners(makeContract('draft'), facts)).toMatchObject({ ok: false, status: 400 });
  });

  it('規則表拒絕的組合不產生序列', () => {
    const facts: RoutingFacts = { documentType: 'management', businessType: 'self_managed' };
    const result = prepareContractSigners(makeContract('draft'), facts);
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(result).not.toHaveProperty('signers');
  });

  it('不送簽的組合不產生序列', () => {
    const facts: RoutingFacts = { documentType: 'handover_certificate', businessType: 'self_managed' };
    expect(prepareContractSigners(makeContract('draft'), facts)).toMatchObject({ ok: false, status: 400 });
  });
});

describe('contractDocumentFileName（送簽文件檔名）', () => {
  it('用物件名稱', () => {
    expect(contractDocumentFileName(makeContract('draft'))).toBe('租賃合約-測試物件');
  });

  it('沒有物件名稱時用合約 ID 末 6 碼', () => {
    const contract = makeContract('draft');
    contract.fields.propertyName = '';
    expect(contractDocumentFileName(contract)).toBe('租賃合約-000001');
  });
});
