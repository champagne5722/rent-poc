import { describe, expect, it } from 'vitest';
import { defaultStatusAnnex, type StatusAnnex } from '../status-annex';
import { ulidOf } from '../test-ids';
import type { ContractRoutingConditions, LeaseContractFields } from '../types';
import { contractTypeDefinition, initialFieldsFor, missingFieldsForSendOf, missingFieldsOf } from './index';

// 租賃合約的必填檢核納入現況確認附件（MIL-71）：包租租賃合約必須填完附件才能往下與送簽，其他組合不檢查。

const MASTER_LEASE: ContractRoutingConditions = { businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: false };

const BASE: LeaseContractFields = {
  landlordName: '北辰租賃住宅管理股份有限公司',
  landlordEmail: 'landlord@example.com',
  tenantName: '李小華',
  tenantEmail: 'tenant@example.com',
  propertyName: '信義小宅',
  propertyAddress: '台北市信義區松仁路 1 號',
  propertyType: '套房',
  propertySize: 12.5,
  rent: 18000,
  deposit: 36000,
  startDate: '2026-12-01',
  endDate: '2027-11-30',
  payDay: 5,
  extra: '',
};

function filled(): StatusAnnex {
  const annex = defaultStatusAnnex();
  return { ...annex, rows: annex.rows.map((r) => ({ ...r, status: 'normal' as const })) };
}

const lease = (fields: LeaseContractFields) => ({ contract_type: 'lease' as const, fields });

describe('包租租賃合約的現況確認附件檢核', () => {
  it('還沒填的附件擋下，列出項數', () => {
    const fields = { ...BASE, routing: MASTER_LEASE };
    expect(missingFieldsOf(lease(fields))).toEqual([`現況確認附件尚有 ${defaultStatusAnnex().rows.length} 項未填狀態`]);
    expect(missingFieldsForSendOf(lease(fields))).toEqual([`現況確認附件尚有 ${defaultStatusAnnex().rows.length} 項未填狀態`]);
  });

  it('有瑕疵的項目沒有備註時擋下', () => {
    const annex = filled();
    annex.rows[0] = { ...annex.rows[0], status: 'defect', note: '' };
    const fields = { ...BASE, routing: MASTER_LEASE, statusAnnex: annex };
    expect(missingFieldsOf(lease(fields))).toEqual([`現況確認附件「${annex.rows[0].label}」有瑕疵，請填備註說明`]);
  });

  it('填完就通過', () => {
    const fields = { ...BASE, routing: MASTER_LEASE, statusAnnex: filled() };
    expect(missingFieldsOf(lease(fields))).toEqual([]);
    expect(missingFieldsForSendOf(lease(fields))).toEqual([]);
  });

  it('與其他欄位缺漏一起列出', () => {
    const fields = { ...BASE, rent: null, routing: MASTER_LEASE };
    expect(missingFieldsOf(lease(fields))).toEqual(['月租金', expect.stringContaining('現況確認附件')]);
  });
});

describe('其他組合不檢查現況確認附件', () => {
  it.each<[string, ContractRoutingConditions | undefined]>([
    ['沒有分流條件的舊合約', undefined],
    ['自管', { businessType: 'self_managed', lesseeIsMasterLessor: false, brokerMediated: false }],
    ['代管', { businessType: 'managed', lesseeIsMasterLessor: false, brokerMediated: false }],
    ['屋主與包租業者（承租人是包租業者）', { businessType: 'self_managed', lesseeIsMasterLessor: true, brokerMediated: false }],
  ])('%s', (_name, routing) => {
    const fields = { ...BASE, ...(routing ? { routing } : {}) };
    expect(missingFieldsOf(lease(fields))).toEqual([]);
    expect(missingFieldsForSendOf(lease(fields))).toEqual([]);
  });

  it('欄位裡留有未填完的附件也不檢查', () => {
    const fields = { ...BASE, routing: { businessType: 'self_managed' as const, lesseeIsMasterLessor: false, brokerMediated: false }, statusAnnex: defaultStatusAnnex() };
    expect(missingFieldsOf(lease(fields))).toEqual([]);
  });
});

describe('建立草稿', () => {
  it('不預先帶附件內容，沒有填過的包租合約讀入不報錯', () => {
    const fields = initialFieldsFor('lease', {
      property: {
        id: ulidOf(1), name: 'x', address: 'y', type: '套房', size: null, default_rent: 1000, note: '', equipment: [], rental_unit_id: ulidOf(2), created_at: '', updated_at: null,
      },
      routing: MASTER_LEASE,
    });
    expect('statusAnnex' in fields).toBe(false);
    expect(() => missingFieldsOf({ contract_type: 'lease', fields })).not.toThrow();
    expect(contractTypeDefinition('lease').sendSupported).toBe(true);
  });
});
