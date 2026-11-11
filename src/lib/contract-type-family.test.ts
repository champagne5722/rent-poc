import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listSummaryOf, missingFieldsOf, partyOf } from './contract-types';
import { createContract, getContract, listContracts } from './contracts';
import { withTx } from './pg/database';
import { setupRouteDb, type RouteDb } from './pg/route-test-kit';
import { newUlid } from './pg/ulid';
import type { OrgTx } from './pg/with-tx';
import type { ContractType } from './labels';
import type { ContractFields } from './types';

// 合約類型加入包租與轉租（MIL-199、migration 0083）：資料庫放寬 CHECK，不回填，既有合約仍是租賃合約。

let kit: RouteDb;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(() => kit.reset());

const inA = <T,>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: kit.orgA }, fn);

const FIELDS = {
  landlordName: '王大明',
  landlordEmail: 'landlord@example.com',
  tenantName: '李小華',
  tenantEmail: 'tenant@example.com',
  propertyName: '信義小宅',
  propertyAddress: '台北市信義區松仁路 1 號',
  propertyType: '整層住家',
  propertySize: 20,
  rent: 20000,
  deposit: 40000,
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  payDay: 5,
  extra: '',
};

describe('合約類型四種', () => {
  it.each(['lease', 'master_lease', 'sublease'] as ContractType[])('%s 合約寫入後讀回，類型與欄位形狀一致', async (type) => {
    const id = await inA((tx) => createContract(tx, { property_id: null, contract_type: type, fields: FIELDS as ContractFields }));
    const contract = (await inA((tx) => getContract(tx, id)))!;
    expect(contract.contract_type).toBe(type);
    expect(partyOf(contract, 'party_a')).toEqual({ name: '王大明', email: 'landlord@example.com' });
    expect(partyOf(contract, 'party_b')).toEqual({ name: '李小華', email: 'tenant@example.com' });
    expect(listSummaryOf(contract)).toMatchObject({ propertyName: '信義小宅', rent: 20000, period: ['2026-01-01', '2026-12-31'] });
    expect((await inA((tx) => listContracts(tx))).map((c) => c.contract_type)).toEqual([type]);
  });

  it('資料庫只認四種類型', async () => {
    await expect(
      inA((tx) =>
        tx.query(`INSERT INTO org.contracts (id, org_id, contract_type, fields) VALUES ($1, $2, 'rental', '{}'::jsonb)`, [
          newUlid(),
          kit.orgA,
        ]),
      ),
    ).rejects.toThrow(/contract_type/);
  });

  it('不回填：不寫類型的列仍是租賃合約，既有的草稿照常開啟與必填檢核', async () => {
    const id = newUlid();
    await inA((tx) =>
      tx.query(`INSERT INTO org.contracts (id, org_id, fields) VALUES ($1, $2, $3::jsonb)`, [id, kit.orgA, JSON.stringify(FIELDS)]),
    );
    const contract = (await inA((tx) => getContract(tx, id)))!;
    expect(contract.contract_type).toBe('lease');
    expect(missingFieldsOf(contract)).toEqual([]);
  });
});
