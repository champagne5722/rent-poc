import type { PGliteInterface } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pgliteDriver } from './drivers';
import { asRole, createTestDb, type TestDb } from './test-harness';
import { newUlid } from './ulid';
import { createWithTx, type OrgTx, type WithTx } from './with-tx';

// MIL-202：registry.get_unit_groups（單位對存續單位與分組鍵）。
// 一律以 app_rw 從外部觀察；要合併單位或錨點時才用 asRole 換成 app_owner。

let testDb: TestDb;
let db: PGliteInterface;
let withTx: WithTx;
const orgA = newUlid();
const orgB = newUlid();

beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(() => testDb.close());

beforeEach(async () => {
  db = await testDb.fresh();
  withTx = createWithTx(pgliteDriver(db));
  await asRole(db, 'app_owner', () =>
    db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'A', 'owner'), ($2, 'B', 'owner')`, [orgA, orgB]),
  );
});

interface Created {
  anchorId: string;
  unitId: string;
}

const insertProperty = (tx: OrgTx, orgId: string, unitId: string) =>
  tx.query('INSERT INTO org.properties (id, org_id, rental_unit_id, name, address) VALUES ($1, $2, $3, $4, $5)', [newUlid(), orgId, unitId, '物件', '某地址']);

const createWhole = (orgId: string): Promise<Created> =>
  withTx({ kind: 'org', orgId }, async (tx) => {
    const anchorId = newUlid();
    const unitId = newUlid();
    await tx.query('SELECT * FROM registry.create_pending_anchor($1, $2, $3)', [anchorId, unitId, '某地址']);
    await insertProperty(tx, orgId, unitId);
    return { anchorId, unitId };
  });

const addSublet = (orgId: string, sourceUnitId: string) =>
  withTx({ kind: 'org', orgId }, async (tx) => {
    const unitId = newUlid();
    await tx.query('SELECT * FROM registry.create_sublet_unit($1, $2, $3, NULL)', [sourceUnitId, unitId, '301']);
    await insertProperty(tx, orgId, unitId);
    return unitId;
  });

const groups = (orgId: string, unitIds: string[]) =>
  withTx({ kind: 'org', orgId }, async (tx) =>
    (await tx.query<{ unit_id: string; survivor_key: string; group_key: string }>('SELECT * FROM registry.get_unit_groups($1::text[])', [unitIds])).rows,
  );

const owner = (sql: string, params: unknown[] = []) => asRole(db, 'app_owner', () => db.query(sql, params));

describe('registry.get_unit_groups', () => {
  it('同一錨點下的整戶與分租單位有相同的分組鍵，不同錨點的分組鍵不同', async () => {
    const whole = await createWhole(orgA);
    const sublet = await addSublet(orgA, whole.unitId);
    const other = await createWhole(orgA);
    const rows = await groups(orgA, [whole.unitId, sublet, other.unitId]);
    const by = new Map(rows.map((r) => [r.unit_id, r]));
    expect(by.size).toBe(3);
    expect(by.get(whole.unitId)!.group_key).toBe(by.get(sublet)!.group_key);
    expect(by.get(whole.unitId)!.group_key).not.toBe(by.get(other.unitId)!.group_key);
    expect(new Set(rows.map((r) => r.survivor_key)).size).toBe(3);
  });

  it('不回原始 ID：分組鍵與存續鍵是 32 碼 md5，不等於任何單位或錨點 ID', async () => {
    const whole = await createWhole(orgA);
    const [row] = await groups(orgA, [whole.unitId]);
    expect(row.survivor_key).toMatch(/^[0-9a-f]{32}$/);
    expect(row.group_key).toMatch(/^[0-9a-f]{32}$/);
    expect([row.survivor_key, row.group_key]).not.toContain(whole.unitId);
    expect([row.survivor_key, row.group_key]).not.toContain(whole.anchorId);
  });

  it('只回呼叫者組織有物件指向的單位：別人的單位與不存在的單位得到空結果', async () => {
    const whole = await createWhole(orgA);
    expect(await groups(orgB, [whole.unitId, newUlid()])).toEqual([]);
  });

  it('被合併的單位解析到存續單位：與存續單位有相同的存續鍵與分組鍵', async () => {
    const survivor = await createWhole(orgA);
    const merged = await createWhole(orgA);
    await owner(`UPDATE registry.rental_units SET status = 'merged', merged_into_id = $2 WHERE id = $1`, [merged.unitId, survivor.unitId]);
    const rows = await groups(orgA, [survivor.unitId, merged.unitId]);
    expect(rows).toHaveLength(2);
    expect(rows[0].survivor_key).toBe(rows[1].survivor_key);
    expect(rows[0].group_key).toBe(rows[1].group_key);
  });

  it('存續單位屬於別的組織：呼叫者只拿到自己的單位，存續鍵不是原始 ID', async () => {
    const survivor = await createWhole(orgB);
    const merged = await createWhole(orgA);
    await owner(`UPDATE registry.rental_units SET status = 'merged', merged_into_id = $2 WHERE id = $1`, [merged.unitId, survivor.unitId]);
    const rows = await groups(orgA, [merged.unitId, survivor.unitId]);
    expect(rows.map((r) => r.unit_id)).toEqual([merged.unitId]);
    expect([rows[0].survivor_key, rows[0].group_key]).not.toContain(survivor.unitId);
    expect([rows[0].survivor_key, rows[0].group_key]).not.toContain(survivor.anchorId);
  });

  it('錨點被合併：沒被合併的單位沿錨點的 merged_into_id 歸到存續錨點', async () => {
    const survivor = await createWhole(orgA);
    const mergedWhole = await createWhole(orgA);
    const mergedSublet = await addSublet(orgA, mergedWhole.unitId);
    await owner(`UPDATE registry.rental_units SET status = 'merged', merged_into_id = $2 WHERE id = $1`, [mergedWhole.unitId, survivor.unitId]);
    await owner(`UPDATE registry.anchors SET status = 'merged', merged_into_id = $2 WHERE id = $1`, [mergedWhole.anchorId, survivor.anchorId]);
    const by = new Map((await groups(orgA, [survivor.unitId, mergedWhole.unitId, mergedSublet])).map((r) => [r.unit_id, r]));
    expect(by.get(mergedSublet)!.group_key).toBe(by.get(survivor.unitId)!.group_key);
    expect(by.get(mergedSublet)!.survivor_key).not.toBe(by.get(survivor.unitId)!.survivor_key);
  });

  it('函式固定 search_path，並對 PUBLIC 撤除執行權', async () => {
    const { rows } = await owner(
      `SELECT p.prosecdef, p.proconfig, has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec, has_function_privilege('app_rw', p.oid, 'EXECUTE') AS rw_exec
         FROM pg_proc p WHERE p.oid = 'registry.get_unit_groups(text[])'::regprocedure`,
    );
    expect(rows[0]).toMatchObject({ prosecdef: true, public_exec: false, rw_exec: true });
    expect((rows[0] as { proconfig: string[] }).proconfig.join(',')).toContain('search_path=registry, pg_temp');
  });
});
