import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTxDriver, withTx } from '../pg/database';
import { pgDriver } from '../pg/drivers';
import { createPgTestDatabase, type PgTestDatabase } from '../pg/pg-database-kit';
import { newUlid } from '../pg/ulid';
import { findCoveringMandateCase, findCoveringMasterLeaseCase } from './index';

// 從物件建立案件的入口查詢，真實 PostgreSQL 版（MIL-209）。PGlite 的完整行為在 src/app/api 的 route 測試。
// 這裡驗證 FORCE RLS 與限定 org_id 下，兩個查詢不會把別的組織的案件當成自己的：
// 1. 別的組織在同一個物件 ID 或租賃單位上的有效委託管理案件與包租案件，這個組織查不到。
// 2. 自家的有效案件查得到，而且優先回 active 的那一筆。
// 只在有 TEST_DATABASE_URL 時執行。
const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('從物件建立案件的入口查詢（真實 PostgreSQL）', () => {
  let dbh: PgTestDatabase;
  const orgA = newUlid();
  const orgB = newUlid();
  const propertyId = newUlid();
  const unitId = newUlid();
  let mandateA = '';
  let draftMandateA = '';
  let masterLeaseA = '';

  const seedMandate = async (orgId: string, state: 'draft' | 'active') => {
    const o = dbh.owner;
    const caseId = newUlid();
    const contractId = newUlid();
    await o.query(`INSERT INTO org.contracts (id, org_id, property_id, contract_type, fields, signature_fields) VALUES ($1, $2, NULL, 'management', '{}'::jsonb, '[]'::jsonb)`, [
      contractId,
      orgId,
    ]);
    await o.query(`INSERT INTO org.cases (id, org_id, kind, state, case_kind, title, current_contract_id) VALUES ($1, $2, 'management', $3, 'management', 't', $4)`, [
      caseId,
      orgId,
      state,
      contractId,
    ]);
    await o.query(
      `INSERT INTO org.contract_mandate_items (id, org_id, contract_id, position, property_id, property_name, property_address, scopes)
       VALUES ($1, $2, $3, 0, $4, 'p', 'a', '[]'::jsonb)`,
      [newUlid(), orgId, contractId, propertyId],
    );
    return caseId;
  };

  const seedMasterLease = async (orgId: string, state: 'draft' | 'active') => {
    const caseId = newUlid();
    await dbh.owner.query(
      `INSERT INTO org.cases (id, org_id, kind, state, business_type, case_kind, rental_unit_id, title) VALUES ($1, $2, 'lease', $3, 'self_managed', 'master_lease', $4, 't')`,
      [caseId, orgId, state, unitId],
    );
    return caseId;
  };

  beforeAll(async () => {
    dbh = await createPgTestDatabase(adminUrl!, 1);
    useTxDriver(pgDriver(dbh.pool));
    await dbh.owner.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'A', 'practice'), ($2, 'B', 'practice')`, [orgA, orgB]);
    // 先建 B 的案件：B 的 ID 較小也較大都不得影響 A 的結果
    await seedMandate(orgB, 'active');
    await seedMasterLease(orgB, 'active');
    draftMandateA = await seedMandate(orgA, 'draft');
    mandateA = await seedMandate(orgA, 'active');
    masterLeaseA = await seedMasterLease(orgA, 'active');
  }, 120_000);

  afterAll(async () => {
    useTxDriver(undefined);
    await dbh?.close();
  });

  const inOrg = <T>(orgId: string, fn: Parameters<typeof withTx>[1]) => withTx({ kind: 'org', orgId, partyId: newUlid() }, fn) as Promise<T>;

  it('自家有效的委託管理案件：查得到，優先回 active', async () => {
    const found = await inOrg<Awaited<ReturnType<typeof findCoveringMandateCase>>>(orgA, (tx) => findCoveringMandateCase(tx, propertyId));
    expect(found).toEqual({ id: mandateA, state: 'active', coversRentalUnit: true });
    expect(found?.id).not.toBe(draftMandateA);
  });

  it('自家有效的包租案件：查得到', async () => {
    const found = await inOrg<Awaited<ReturnType<typeof findCoveringMasterLeaseCase>>>(orgA, (tx) => findCoveringMasterLeaseCase(tx, unitId));
    expect(found).toMatchObject({ id: masterLeaseA, orgId: orgA, state: 'active' });
  });

  it('沒有案件的組織：別的組織的案件查不到', async () => {
    const orgC = newUlid();
    await dbh.owner.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'C', 'practice')`, [orgC]);
    expect(await inOrg(orgC, (tx) => findCoveringMandateCase(tx, propertyId))).toBeNull();
    expect(await inOrg(orgC, (tx) => findCoveringMasterLeaseCase(tx, unitId))).toBeNull();
  });
});
