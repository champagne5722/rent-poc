import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listSummaryOf, missingFieldsOf, partyOf } from './contract-types';
import { createContract, getContract, listContracts } from './contracts';
import { withTx } from './pg/database';
import { setupRouteDb, type RouteDb } from './pg/route-test-kit';
import { newUlid } from './pg/ulid';
import type { OrgTx } from './pg/with-tx';
import type { ContractFields } from './types';

// 合約欄位以 contract_type 判別（MIL-73）：既有合約讀入後都是租賃合約的形狀。
// 合約在 PostgreSQL（PGlite），contract_type 欄位的預設值是 'lease'（db/migrations/0004_contracts.sql）。

let kit: RouteDb;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(() => kit.reset());

const inA = <T,>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: kit.orgA }, fn);

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
  it('沒有 contract_type 欄位值的舊列（欄位預設）讀成租賃合約，欄位照租賃形狀取值', async () => {
    const id = newUlid();
    // 不寫 contract_type：走欄位預設，等同這個欄位出現之前建立的列
    await inA((tx) =>
      tx.query(`INSERT INTO org.contracts (id, org_id, fields) VALUES ($1, $2, $3::jsonb)`, [
        id,
        kit.orgA,
        JSON.stringify(LEGACY_FIELDS),
      ]),
    );
    const contract = (await inA((tx) => getContract(tx, id)))!;

    expect(contract.contract_type).toBe('lease');
    expect(partyOf(contract, 'party_a')).toEqual({ name: '王大明', email: 'landlord@example.com' });
    expect(partyOf(contract, 'party_b')).toEqual({ name: '李小華', email: 'tenant@example.com' });
    expect(listSummaryOf(contract)).toMatchObject({ propertyName: '舊合約物件', period: ['2026-01-01', '2026-12-31'] });
    expect(missingFieldsOf(contract)).toEqual([]);
  });

  it('列表與單筆讀出的類型一致', async () => {
    await inA((tx) => createContract(tx, { property_id: null, fields: LEGACY_FIELDS as ContractFields }));
    expect((await inA((tx) => listContracts(tx))).map((c) => c.contract_type)).toEqual(['lease']);
  });

  it('委託管理合約依類型取當事人，不會讀成租賃的欄位', async () => {
    const id = await inA((tx) =>
      createContract(tx, {
        property_id: null,
        contract_type: 'management',
        fields: {
          mandatorName: '陳屋主',
          mandatorEmail: 'owner@example.com',
          mandataryName: '北辰管理',
          mandataryEmail: 'manager@example.com',
          extra: '',
        },
      }),
    );
    const contract = (await inA((tx) => getContract(tx, id)))!;
    expect(contract.contract_type).toBe('management');
    expect(partyOf(contract, 'party_b')).toEqual({ name: '北辰管理', email: 'manager@example.com' });
  });
});
