import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureSchema, insertContractWithEvent, setDb } from '@/lib/db';
import { pgDriver } from '@/lib/pg/drivers';
import { createPgTestDatabase, type PgTestDatabase } from '@/lib/pg/pg-database-kit';
import { newUlid } from '@/lib/pg/ulid';
import { createWithTx, type WithTx } from '@/lib/pg/with-tx';
import { createProperty, createSubletUnit, getProperty, listSiblingUnits, parsePropertyInput, parseSubletInput, removeProperty } from '.';

// MIL-145 的真實 PostgreSQL 測試：兩個交易同時搶同一個錨點的下一號、跨組織持有計數、封存。
// PGlite 是單連線，測不出併發。只在有 TEST_DATABASE_URL 時執行（見 pg-integration.test.ts）。

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('分租單位、持有計數與封存（真實 PostgreSQL）', () => {
  let dbh: PgTestDatabase;
  let withTx: WithTx;
  let sqlite: Database.Database;
  const orgA = newUlid();
  const orgB = newUlid();

  beforeAll(async () => {
    sqlite = new Database(':memory:');
    ensureSchema(sqlite);
    setDb(sqlite);
    dbh = await createPgTestDatabase(adminUrl!, 4);
    withTx = createWithTx(pgDriver(dbh.pool));
    await dbh.owner.query(`SET ROLE app_owner; INSERT INTO control.orgs (id, name, kind) VALUES ('${orgA}', 'A', 'owner'), ('${orgB}', 'B', 'owner'); RESET ROLE`);
  });
  afterAll(async () => {
    setDb(null);
    await dbh.close();
  });

  const whole = async (orgId: string) => {
    const parsed = parsePropertyInput({ name: '整戶', address: '台北市大安區某路 1 號', equipment: [] });
    if (!parsed.ok) throw new Error(parsed.error);
    return withTx({ kind: 'org', orgId }, (tx) => createProperty(tx, parsed.value));
  };
  const subInput = (label: string) => {
    const parsed = parseSubletInput({ label });
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  };
  const unitStatus = async (propertyId: string, orgId: string) => {
    const unitId = await withTx({ kind: 'org', orgId }, async (tx) => (await getProperty(tx, propertyId))!.rental_unit_id);
    const { rows } = await dbh.owner.query('SELECT status, holder_count FROM registry.rental_units WHERE id = $1', [unitId]);
    return rows[0];
  };

  it('兩個交易同時在同一錨點新增分租單位，後綴不重複也不跳號', async () => {
    const wholeId = await whole(orgA);
    const results = await Promise.all(
      ['301', '302', '303', '304'].map((label) => withTx({ kind: 'org', orgId: orgA }, (tx) => createSubletUnit(tx, wholeId, subInput(label)))),
    );
    const suffixes = results.map((r) => (r.kind === 'created' ? r.suffix : r.kind)).sort();
    expect(suffixes).toEqual(['0001', '0002', '0003', '0004']);
    const siblings = await withTx({ kind: 'org', orgId: orgA }, (tx) => listSiblingUnits(tx, wholeId));
    expect(siblings!.map((u) => u.suffix)).toEqual(['0000', '0001', '0002', '0003', '0004']);
  });

  it('交易失敗時單位與物件一起回滾，後綴沒有被佔走', async () => {
    const wholeId = await whole(orgA);
    await expect(
      withTx({ kind: 'org', orgId: orgA }, async (tx) => {
        await createSubletUnit(tx, wholeId, subInput('301'));
        throw new Error('故意失敗');
      }),
    ).rejects.toThrow('故意失敗');
    const next = await withTx({ kind: 'org', orgId: orgA }, (tx) => createSubletUnit(tx, wholeId, subInput('301')));
    expect(next).toMatchObject({ kind: 'created', suffix: '0001' });
  });

  it('別的組織的物件：不能新增分租單位', async () => {
    const wholeId = await whole(orgA);
    const result = await withTx({ kind: 'org', orgId: orgB }, (tx) => createSubletUnit(tx, wholeId, subInput('301')));
    expect(result).toEqual({ kind: 'not_found' });
  });

  it('刪除：沒有合約時刪物件列、單位轉 retired；有合約時封存、單位仍 active', async () => {
    const plain = await whole(orgA);
    expect(await unitStatus(plain, orgA)).toEqual({ status: 'active', holder_count: 1 });
    expect(await withTx({ kind: 'org', orgId: orgA }, (tx) => removeProperty(tx, plain))).toBe('deleted');
    const { rows } = await dbh.owner.query(
      `SELECT status, holder_count FROM registry.rental_units u WHERE u.id NOT IN (SELECT rental_unit_id FROM org.properties) AND status = 'retired'`,
    );
    expect(rows.length).toBeGreaterThan(0);

    const withContract = await whole(orgA);
    insertContractWithEvent({ property_id: withContract, fields: '{}' }, { type: 'created', actor: 'landlord' });
    expect(await withTx({ kind: 'org', orgId: orgA }, (tx) => removeProperty(tx, withContract))).toBe('archived');
    expect(await unitStatus(withContract, orgA)).toEqual({ status: 'active', holder_count: 1 });
    expect((await withTx({ kind: 'org', orgId: orgA }, (tx) => getProperty(tx, withContract)))!.archived_at).toMatch(/^\d{4}-/);
  });

  it('兩個組織共用一個單位：一方刪除不轉 retired，雙方都刪除才轉', async () => {
    const aProperty = await whole(orgA);
    const unitId = await withTx({ kind: 'org', orgId: orgA }, async (tx) => (await getProperty(tx, aProperty))!.rental_unit_id);
    const bProperty = newUlid();
    await withTx({ kind: 'org', orgId: orgB }, (tx) =>
      tx.query(`INSERT INTO org.properties (id, org_id, rental_unit_id, name, address) VALUES ($1, current_setting('app.org_id', true), $2, 'B 的', '地址')`, [
        bProperty,
        unitId,
      ]),
    );
    const read = async () => (await dbh.owner.query('SELECT status, holder_count FROM registry.rental_units WHERE id = $1', [unitId])).rows[0];
    expect(await read()).toEqual({ status: 'active', holder_count: 2 });
    await withTx({ kind: 'org', orgId: orgA }, (tx) => removeProperty(tx, aProperty));
    expect(await read()).toEqual({ status: 'active', holder_count: 1 });
    await withTx({ kind: 'org', orgId: orgB }, (tx) => removeProperty(tx, bProperty));
    expect(await read()).toEqual({ status: 'retired', holder_count: 0 });
  });
});
