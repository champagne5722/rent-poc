import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgDriver } from './drivers';
import { createPgTestDatabase, type PgTestDatabase } from './pg-database-kit';
import { newUlid } from './ulid';
import { createWithTx, type WithTx } from './with-tx';

// registry.get_unit_groups 在真實 PostgreSQL 上的隔離（MIL-202）。PGlite 的案例在 unit-groups-schema.test.ts。
// 只在有 TEST_DATABASE_URL 時執行，說明見 pg-integration.test.ts。

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('registry.get_unit_groups（真實 PostgreSQL）', () => {
  let dbh: PgTestDatabase;
  let withTx: WithTx;
  const orgA = newUlid();
  const orgB = newUlid();
  const unitA = newUlid();
  const unitB = newUlid();

  const groups = (orgId: string, unitIds: string[]) =>
    withTx({ kind: 'org', orgId }, async (tx) => (await tx.query<{ unit_id: string }>('SELECT * FROM registry.get_unit_groups($1::text[])', [unitIds])).rows);

  beforeAll(async () => {
    dbh = await createPgTestDatabase(adminUrl!, 4);
    withTx = createWithTx(pgDriver(dbh.pool));
    await dbh.owner.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'A', 'owner'), ($2, 'B', 'owner')`, [orgA, orgB]);
    for (const [orgId, unitId] of [
      [orgA, unitA],
      [orgB, unitB],
    ]) {
      await withTx({ kind: 'org', orgId }, async (tx) => {
        await tx.query('SELECT * FROM registry.create_pending_anchor($1, $2, $3)', [newUlid(), unitId, '某地址']);
        await tx.query('INSERT INTO org.properties (id, org_id, rental_unit_id, name, address) VALUES ($1, $2, $3, $4, $5)', [newUlid(), orgId, unitId, '物件', '某地址']);
      });
    }
  });

  afterAll(async () => {
    await dbh?.close();
  });

  it('只回呼叫者組織有物件指向的單位', async () => {
    expect((await groups(orgA, [unitA, unitB])).map((r) => r.unit_id)).toEqual([unitA]);
    expect((await groups(orgB, [unitA, unitB])).map((r) => r.unit_id)).toEqual([unitB]);
    expect(await groups(orgA, [newUlid()])).toEqual([]);
  });
});
