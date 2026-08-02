import { describe, expect, it } from 'vitest';
import type { Contract, ContractStatus } from './types';
import { currentSigner } from './signing';

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
      equipment: [],
      rent: 15000,
      deposit: 30000,
      startDate: '2026-09-01',
      endDate: '2027-08-31',
      payDay: 5,
      extra: '',
    },
    signature_fields: [],
    dottedsign_task_id: '123',
    declined_reason: null,
    derived_from: null,
    created_at: '2026-08-01 00:00:00',
    updated_at: null,
  };
}

describe('currentSigner（當前待簽方）', () => {
  it('待乙方簽時，當前待簽方是租客', () => {
    expect(currentSigner(makeContract('awaiting_tenant'))).toEqual({
      role: 'tenant',
      name: '王租客',
      email: 'tenant@example.com',
    });
  });

  it('待甲方簽時，當前待簽方是房東', () => {
    expect(currentSigner(makeContract('awaiting_landlord'))).toEqual({
      role: 'landlord',
      name: '林房東',
      email: 'landlord@example.com',
    });
  });

  it.each(['draft', 'completed', 'declined', 'voided'] as const)('%s 沒有當前待簽方', (status) => {
    expect(currentSigner(makeContract(status))).toBeNull();
  });
});
