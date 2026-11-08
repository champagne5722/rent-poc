import { describe, expect, it } from 'vitest';
import type { Contract, ContractStatus } from './types';
import { contractDocumentFileName, contractSignerSequence } from './signing';

function makeContract(status: ContractStatus): Contract {
  return {
    id: 1,
    property_id: null,
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

describe('contractSignerSequence（租賃合約的簽署序列）', () => {
  it('乙方在前、甲方在後，各自帶自己的簽署區域', () => {
    const partyBField = { id: 'f1', signer: 'party_b', page: 0, x: 0.1, y: 0.8, w: 0.2, h: 0.1 } as const;
    const partyAField = { id: 'f2', signer: 'party_a', page: 1, x: 0.6, y: 0.8, w: 0.2, h: 0.1 } as const;
    const contract = { ...makeContract('draft'), signature_fields: [partyAField, partyBField] };

    expect(contractSignerSequence(contract)).toEqual([
      { role: 'party_b', name: '王租客', email: 'tenant@example.com', signatureFields: [partyBField] },
      { role: 'party_a', name: '林房東', email: 'landlord@example.com', signatureFields: [partyAField] },
    ]);
  });
});

describe('contractDocumentFileName（送簽文件檔名）', () => {
  it('用物件名稱', () => {
    expect(contractDocumentFileName(makeContract('draft'))).toBe('租賃合約-測試物件');
  });

  it('沒有物件名稱時用合約編號', () => {
    const contract = makeContract('draft');
    contract.fields.propertyName = '';
    expect(contractDocumentFileName(contract)).toBe('租賃合約-1');
  });
});
