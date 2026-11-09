import type { PGliteInterface } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pgliteDriver } from './drivers';
import {
  CONTROL_TABLE_EXCEPTIONS,
  controlTablesWithoutException,
  ORG_TABLE_CASES,
  tablesWithoutCase,
} from './rls-cases';
import { asRole, createTestDb, type TestDb } from './test-harness';
import { newUlid } from './ulid';
import { createWithTx, type Tx, type WithTx } from './with-tx';

// 滲透測試骨架（MIL-81，ADR-0012 決議 6）。MIL-89 在這個骨架上加系統目錄檢查與表專屬探測。

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(() => testDb.close());

const ORG_TABLES_SQL = `SELECT n.nspname || '.' || c.relname AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'org' AND c.relkind IN ('r', 'p') ORDER BY 1`;

async function orgTables(): Promise<string[]> {
  const { rows } = await testDb.base.query<{ name: string }>(ORG_TABLES_SQL);
  return rows.map((r) => r.name);
}

describe('案例清單機制', () => {
  it('org schema 的每張表都登記了案例（沒有案例就失敗）', async () => {
    const missing = tablesWithoutCase(await orgTables());
    expect(missing, `這些 org 表沒有滲透測試案例，請到 src/lib/pg/rls-cases.ts 登記：${missing.join('、')}`).toEqual([]);
  });

  it('案例清單裡沒有不存在的表（表改名或刪除時要同步清單）', async () => {
    const tables = new Set(await orgTables());
    const stale = Object.keys(ORG_TABLE_CASES).filter((t) => !tables.has(t));
    expect(stale, `案例清單有不存在的表：${stale.join('、')}`).toEqual([]);
  });

  it('機制本身有效：加一張沒登記的 org 表，同一個檢查會抓到', async () => {
    const db = await testDb.base.clone();
    try {
      await db.exec('SET ROLE app_owner');
      await db.exec('CREATE TABLE org.unregistered_probe (id text PRIMARY KEY, org_id text NOT NULL)');
      const { rows } = await db.query<{ name: string }>(ORG_TABLES_SQL);
      expect(tablesWithoutCase(rows.map((r) => r.name))).toEqual(['org.unregistered_probe']);
    } finally {
      await db.close();
    }
  });
});

const CONTROL_TABLES_SQL = `SELECT n.nspname || '.' || c.relname AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'control' AND c.relkind IN ('r', 'p') ORDER BY 1`;

describe('control 表的例外清單', () => {
  const controlTables = async () => (await testDb.base.query<{ name: string }>(CONTROL_TABLES_SQL)).rows.map((r) => r.name);

  it('每張 control 表都登記在例外清單（沒有登記就失敗）', async () => {
    const missing = controlTablesWithoutException(await controlTables());
    expect(missing, `這些 control 表沒有登記，請到 src/lib/pg/rls-cases.ts 的 CONTROL_TABLE_EXCEPTIONS 登記：${missing.join('、')}`).toEqual([]);
  });

  it('清單裡沒有不存在的表', async () => {
    const tables = new Set(await controlTables());
    expect(Object.keys(CONTROL_TABLE_EXCEPTIONS).filter((t) => !tables.has(t))).toEqual([]);
  });

  it('app_rw 的直接 DML 權限與清單一致，PUBLIC 沒有任何權限', async () => {
    for (const [table, exception] of Object.entries(CONTROL_TABLE_EXCEPTIONS)) {
      const actual: string[] = [];
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        const { rows } = await testDb.base.query<{ ok: boolean }>(`SELECT has_table_privilege('app_rw', $1, $2) AS ok`, [table, privilege]);
        if (rows[0].ok) actual.push(privilege);
      }
      expect(actual, `${table} 給 app_rw 的權限`).toEqual([...exception.appRw]);
      const { rows } = await testDb.base.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_class c, aclexplode(c.relacl) a
          WHERE c.oid = $1::regclass AND a.grantee = 0`,
        [table],
      );
      expect(rows[0].n, `${table} 不得對 PUBLIC 授權`).toBe(0);
    }
  });

  it('機制本身有效：加一張沒登記的 control 表，同一個檢查會抓到', async () => {
    const db = await testDb.base.clone();
    try {
      await db.exec('SET ROLE app_owner');
      await db.exec('CREATE TABLE control.unregistered_probe (id text PRIMARY KEY)');
      const { rows } = await db.query<{ name: string }>(CONTROL_TABLES_SQL);
      expect(controlTablesWithoutException(rows.map((r) => r.name))).toEqual(['control.unregistered_probe']);
    } finally {
      await db.close();
    }
  });
});

describe('每張 org 表的 RLS 設定', () => {
  it('org_id 欄位不得為空，已 ENABLE 且 FORCE RLS，且至少有一條政策', async () => {
    for (const table of await orgTables()) {
      const [schema, name] = table.split('.');
      const { rows } = await testDb.base.query<{ enabled: boolean; forced: boolean; policies: string; org_id_not_null: boolean | null }>(
        `SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
                (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::text AS policies,
                (SELECT a.attnotnull FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped) AS org_id_not_null
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2`,
        [schema, name],
      );
      expect({ table, ...rows[0] }, `${table} 的 RLS 設定`).toEqual({
        table,
        enabled: true,
        forced: true,
        policies: expect.not.stringMatching(/^0$/),
        org_id_not_null: true,
      });
    }
  });
});

// control 的表不掛組織 RLS（ADR-0012 決議 3）。這裡確認「不掛」是登記過的決定，而且權限逐表授予、沒有多給。
describe('control schema 的表（不掛組織 RLS，登記為例外）', () => {
  const CONTROL_TABLES_SQL = `SELECT n.nspname || '.' || c.relname AS name, c.relrowsecurity AS rls
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'control' AND c.relkind IN ('r', 'p') ORDER BY 1`;

  it('control 的每張表都登記了例外與理由（沒登記就失敗）', async () => {
    const { rows } = await testDb.base.query<{ name: string }>(CONTROL_TABLES_SQL);
    const missing = rows.map((r) => r.name).filter((t) => !(t in CONTROL_TABLE_EXCEPTIONS));
    expect(missing, `這些 control 表沒有登記，請到 src/lib/pg/rls-cases.ts 的 CONTROL_TABLE_EXCEPTIONS 登記：${missing.join('、')}`).toEqual([]);
  });

  it('登記的表都存在（表改名或刪除時要同步清單）', async () => {
    const { rows } = await testDb.base.query<{ name: string }>(CONTROL_TABLES_SQL);
    const tables = new Set(rows.map((r) => r.name));
    expect(Object.keys(CONTROL_TABLE_EXCEPTIONS).filter((t) => !tables.has(t))).toEqual([]);
  });

  it('沒有任何 control 表掛了 RLS：掛了就不是例外，要改進 ORG_TABLE_CASES', async () => {
    const { rows } = await testDb.base.query<{ name: string; rls: boolean }>(CONTROL_TABLES_SQL);
    expect(rows.filter((r) => r.rls).map((r) => r.name)).toEqual([]);
  });

  it('app_rw 的權限和登記的一模一樣，不多給（登入表尤其不得有 TRUNCATE 與 REFERENCES）', async () => {
    for (const [table, exception] of Object.entries(CONTROL_TABLE_EXCEPTIONS)) {
      const { rows } = await testDb.base.query<{ p: string }>(
        `SELECT p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS p
          WHERE has_table_privilege('app_rw', $1, p) ORDER BY 1`,
        [table],
      );
      expect({ table, privileges: rows.map((r) => r.p) }).toEqual({ table, privileges: [...exception.appRw].sort() });
    }
  });
});

describe.each(Object.entries(ORG_TABLE_CASES))('%s 的跨組織探測', (table, testCase) => {
  let db: PGliteInterface;
  let withTx: WithTx;
  const orgA = newUlid();
  const orgB = newUlid();

  beforeEach(async () => {
    db = await testDb.fresh();
    withTx = createWithTx(pgliteDriver(db));
    await asRole(db, 'app_owner', async () => {
      await db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'A', 'owner'), ($2, 'B', 'owner')`, [orgA, orgB]);
    });
  });

  const seedA = () => withTx({ kind: 'org', orgId: orgA }, (tx) => testCase.seed(tx, orgA));
  const asB = <T>(fn: (tx: Tx<'org'>) => Promise<T>) => withTx({ kind: 'org', orgId: orgB }, fn);

  it('自己看得到這一列', async () => {
    const id = await seedA();
    const rows = await withTx({ kind: 'org', orgId: orgA }, (tx) => tx.query(`SELECT id FROM ${table} WHERE id = $1`, [id]));
    expect(rows.rows).toHaveLength(1);
  });

  it('別的組織看不到、改不到、刪不到', async () => {
    const id = await seedA();
    expect((await asB((tx) => tx.query(`SELECT id FROM ${table} WHERE id = $1`, [id]))).rows).toEqual([]);
    expect((await asB((tx) => tx.query(`SELECT count(*)::int AS n FROM ${table}`))).rows).toEqual([{ n: 0 }]);
    if (testCase.appendOnly) {
      // 只增不改的表：app_rw 沒有 UPDATE 與 DELETE 權限，連別的組織的列也不必碰就被擋
      await expect(asB((tx) => tx.query(`UPDATE ${table} SET org_id = org_id WHERE id = $1 RETURNING id`, [id]))).rejects.toThrow(/permission denied/);
      await expect(asB((tx) => tx.query(`DELETE FROM ${table} WHERE id = $1 RETURNING id`, [id]))).rejects.toThrow(/permission denied/);
    } else {
      expect((await asB((tx) => tx.query(`UPDATE ${table} SET org_id = org_id WHERE id = $1 RETURNING id`, [id]))).rows).toEqual([]);
      expect((await asB((tx) => tx.query(`DELETE FROM ${table} WHERE id = $1 RETURNING id`, [id]))).rows).toEqual([]);
    }
    const stillThere = await withTx({ kind: 'org', orgId: orgA }, (tx) => tx.query(`SELECT id FROM ${table} WHERE id = $1`, [id]));
    expect(stillThere.rows).toHaveLength(1);
  });

  it('不能把列的 org_id 改成別的組織', async () => {
    const id = await seedA();
    await expect(
      withTx({ kind: 'org', orgId: orgA }, (tx) => tx.query(`UPDATE ${table} SET org_id = $2 WHERE id = $1`, [id, orgB])),
    ).rejects.toThrow(testCase.appendOnly ? /permission denied/ : /row-level security/);
  });

  it('在自己的脈絡寫入別的組織的 org_id，被 RLS 擋下', async () => {
    await expect(withTx({ kind: 'org', orgId: orgA }, (tx) => testCase.seed(tx, orgB))).rejects.toThrow(/row-level security/);
  });

  it('沒有組織脈絡（control）時 0 筆', async () => {
    await seedA();
    const rows = await withTx({ kind: 'control' }, (tx) => tx.query(`SELECT count(*)::int AS n FROM ${table}`));
    expect(rows.rows).toEqual([{ n: 0 }]);
  });

  it('只有 party 脈絡（承租人）時 0 筆', async () => {
    await seedA();
    const rows = await withTx({ kind: 'party', partyId: newUlid() }, (tx) => tx.query(`SELECT count(*)::int AS n FROM ${table}`));
    expect(rows.rows).toEqual([{ n: 0 }]);
  });

  it('兩個組織用同一組業務鍵各寫一列都成功，撞號不會洩漏別的組織有這一列（陷阱 6）', async () => {
    await seedA();
    await expect(asB((tx) => testCase.seed(tx, orgB))).resolves.toBeTruthy();
  });
});
