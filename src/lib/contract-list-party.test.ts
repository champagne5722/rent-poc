import { describe, expect, it } from 'vitest';
import { listPartyBColumn, listPeriodLabel, listPropertyLabel, listRentLabel } from './contract-list';
import type { Contract, SignatureField } from './types';

// 合約清單的欄名與儲存格依合約類型取字（MIL-73，MIL-122 留的事）。
// 清單全是同一種類型時，欄名用那個類型的稱謂。混著兩種時用「乙方」，儲存格補上稱謂。

const BASE = {
  property_id: null,
  status: 'draft' as const,
  signature_fields: [] as SignatureField[],
  declined_reason: null,
  derived_from: null,
  created_at: '2026-08-01 00:00:00',
  updated_at: null,
};

const lease: Contract = {
  ...BASE,
  id: 1,
  contract_type: 'lease',
  fields: {
    landlordName: '林出租',
    landlordEmail: 'landlord@example.com',
    tenantName: '王承租',
    tenantEmail: 'tenant@example.com',
    propertyName: '信義套房',
    propertyAddress: '台北市測試路 1 號',
    propertyType: '套房',
    propertySize: 10,
    rent: 15000,
    deposit: 30000,
    startDate: '2026-09-01',
    endDate: '2027-08-31',
    payDay: 5,
    extra: '',
  },
};

const management: Contract = {
  ...BASE,
  id: 2,
  contract_type: 'management',
  fields: {
    mandatorName: '陳屋主',
    mandatorEmail: 'owner@example.com',
    mandataryName: '北辰管理',
    mandataryEmail: 'manager@example.com',
    termStart: '',
    termEnd: '',
    feeMode: null,
    feeValue: null,
    extra: '',
  },
};

describe('listPartyBColumn', () => {
  it('全是租賃合約：欄名是乙方（承租人），儲存格只有姓名', () => {
    const column = listPartyBColumn([lease]);
    expect(column.title).toBe('乙方（承租人）');
    expect(column.cell(lease)).toBe('王承租');
  });

  it('全是委託管理合約：欄名是乙方（受託人）', () => {
    const column = listPartyBColumn([management]);
    expect(column.title).toBe('乙方（受託人）');
    expect(column.cell(management)).toBe('北辰管理');
  });

  it('清單是空的：沿用租賃合約的欄名', () => {
    expect(listPartyBColumn([]).title).toBe('乙方（承租人）');
  });

  it('兩種類型混在一起：欄名是乙方，儲存格補上各自的稱謂', () => {
    const column = listPartyBColumn([lease, management]);
    expect(column.title).toBe('乙方');
    expect(column.cell(lease)).toBe('王承租（承租人）');
    expect(column.cell(management)).toBe('北辰管理（受託人）');
  });

  it('姓名沒填顯示破折號', () => {
    const blank = { ...lease, fields: { ...lease.fields, tenantName: '' } } as Contract;
    expect(listPartyBColumn([blank]).cell(blank)).toBe('—');
  });
});

describe('清單其他欄位', () => {
  it('租賃合約：物件、租金、租期', () => {
    expect(listPropertyLabel(lease)).toBe('信義套房');
    expect(listRentLabel(lease)).toBe('$15,000');
    expect(listPeriodLabel(lease)).toBe('2026-09-01 ~ 2027-08-31');
  });

  it('委託管理合約：沒有單一物件、租金與租期，顯示破折號', () => {
    expect(listPropertyLabel(management)).toBe('—');
    expect(listRentLabel(management)).toBe('—');
    expect(listPeriodLabel(management)).toBe('—');
  });
});
