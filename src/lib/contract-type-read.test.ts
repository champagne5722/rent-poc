import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listSummaryOf, missingFieldsOf, partyOf } from './contract-types';
import { ensureSchema, getContract, insertContractWithEvent, listContracts, setDb } from './db';

// 合約欄位以 contract_type 判別（MIL-73）：既有合約讀入後都是租賃合約的形狀。

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  ensureSchema(db);
  setDb(db);
});

afterEach(() => {
  setDb(null);
  db.close();
});

const LEGACY_FIELDS = {
  landlordName: '王大明',
  landlordEmail: 'landlord@example.com',
  tenantName: '李小華',
  tenantEmail: 'tenant@example.com',
  propertyName: '舊合約物件',
  propertyAddress: '台北市中正區測試路 1 號',
  propertyType: '整層住家',
  propertySize: 20,
  rent: 20000,
  deposit: 40000,
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  payDay: 5,
  extra: '',
};

describe('既有合約讀入', () => {
  it('沒有 contract_type 欄位值的舊列（欄位預設）讀成租賃合約，欄位照租賃形狀取值', () => {
    const result = db
      .prepare('INSERT INTO contracts (property_id, fields, signature_fields) VALUES (?, ?, ?)')
      .run(null, JSON.stringify(LEGACY_FIELDS), '[]');
    const contract = getContract(Number(result.lastInsertRowid))!;

    expect(contract.contract_type).toBe('lease');
    expect(partyOf(contract, 'party_a')).toEqual({ name: '王大明', email: 'landlord@example.com' });
    expect(partyOf(contract, 'party_b')).toEqual({ name: '李小華', email: 'tenant@example.com' });
    expect(listSummaryOf(contract)).toMatchObject({ propertyName: '舊合約物件', period: ['2026-01-01', '2026-12-31'] });
    expect(missingFieldsOf(contract)).toEqual([]);
  });

  it('列表與單筆讀出的類型一致', () => {
    insertContractWithEvent(
      { property_id: null, fields: JSON.stringify(LEGACY_FIELDS) },
      { type: 'created', actor: 'landlord' },
      db,
    );
    expect(listContracts().map((c) => c.contract_type)).toEqual(['lease']);
  });

  it('委託管理合約依類型取當事人，不會讀成租賃的欄位', () => {
    const id = insertContractWithEvent(
      {
        property_id: null,
        contract_type: 'management',
        fields: JSON.stringify({
          mandatorName: '陳屋主',
          mandatorEmail: 'owner@example.com',
          mandataryName: '北辰管理',
          mandataryEmail: 'manager@example.com',
          extra: '',
        }),
      },
      { type: 'created', actor: 'landlord' },
      db,
    );
    const contract = getContract(id)!;
    expect(contract.contract_type).toBe('management');
    expect(partyOf(contract, 'party_b')).toEqual({ name: '北辰管理', email: 'manager@example.com' });
  });
});
