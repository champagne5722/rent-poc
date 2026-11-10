import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgliteDriver } from './drivers';
import {
  CONTROL_TABLE_EXCEPTIONS,
  controlTablesWithoutException,
  DEFINER_ONLY_TABLES,
  definerOnlyTablesWithoutEntry,
  ORG_TABLE_CASES,
  REGISTRY_FUNCTION_CASES,
  REGISTRY_TABLE_CASES,
  registryFunctionsWithoutCase,
  registryTablesWithoutCase,
  tablesWithoutCase,
} from './rls-cases';
import {
  describeForeignKeyPenetration,
  describeOrgTablePenetration,
  describeRegistryFunctionPenetration,
  type PenetrationEnv,
} from './rls-penetration-suite';
import { asRole, createTestDb, type TestDb } from './test-harness';
import { createWithTx } from './with-tx';

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
    const db = await testDb.raw();
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
    const db = await testDb.raw();
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

describe('registry 與 vault 的表（只經定義者函式，MIL-109）', () => {
  const TABLES_SQL = `SELECT n.nspname || '.' || c.relname AS name, c.relrowsecurity AS rls
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('registry', 'vault') AND c.relkind IN ('r', 'p') ORDER BY 1`;

  it('每張表都登記了（沒登記就失敗），清單裡沒有不存在的表', async () => {
    const { rows } = await testDb.base.query<{ name: string }>(TABLES_SQL);
    const names = rows.map((r) => r.name);
    const missing = definerOnlyTablesWithoutEntry(names);
    expect(missing, `這些表沒有登記，請到 src/lib/pg/rls-cases.ts 的 DEFINER_ONLY_TABLES 登記：${missing.join('、')}`).toEqual([]);
    expect(Object.keys(DEFINER_ONLY_TABLES).filter((t) => !names.includes(t))).toEqual([]);
  });

  it('app_rw 與 PUBLIC 對這些表沒有任何權限，直接查會被拒', async () => {
    for (const table of Object.keys(DEFINER_ONLY_TABLES)) {
      const { rows } = await testDb.base.query<{ p: string; who: string }>(
        `SELECT p, who FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS p,
                unnest(ARRAY['app_rw']) AS who WHERE has_table_privilege(who, $1, p)`,
        [table],
      );
      expect({ table, privileges: rows.map((r) => r.p) }).toEqual({ table, privileges: [] });
      const acl = await testDb.base.query<{ acl: string | null }>('SELECT relacl::text AS acl FROM pg_class WHERE oid = $1::regclass', [table]);
      expect({ table, publicGrant: /(^|[{,])=/.test(acl.rows[0].acl ?? '') }).toEqual({ table, publicGrant: false });
    }
  });

  it('app_rw 能執行的 registry 與 vault 函式都是 SECURITY DEFINER、固定 search_path、PUBLIC 不能執行（ADR-0012 決議 8）', async () => {
    const { rows } = await testDb.base.query<{ name: string; secdef: boolean; has_path: boolean; public_exec: boolean }>(
      `SELECT n.nspname || '.' || p.proname AS name, p.prosecdef AS secdef,
              coalesce(p.proconfig::text ~ 'search_path=', false) AS has_path,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('registry', 'vault') AND has_function_privilege('app_rw', p.oid, 'EXECUTE') ORDER BY 1`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => !r.secdef || !r.has_path || r.public_exec).map((r) => r.name)).toEqual([]);
  });

  it('函式的擁有者沒有 SUPERUSER 與 BYPASSRLS', async () => {
    const { rows } = await testDb.base.query<{ name: string }>(
      `SELECT DISTINCT n.nspname || '.' || p.proname AS name
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles r ON r.oid = p.proowner
        WHERE n.nspname IN ('registry', 'vault') AND (r.rolsuper OR r.rolbypassrls)`,
    );
    expect(rows).toEqual([]);
  });
});

// 通用探測的本體在 rls-penetration-suite.ts，真實 PostgreSQL 版是 rls-penetration.pg.test.ts。
const penetrationEnv: PenetrationEnv = {
  async prepare(orgA, orgB) {
    const db = await testDb.fresh();
    await asRole(db, 'app_owner', async () => {
      await db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'A', 'owner'), ($2, 'B', 'owner')`, [orgA, orgB]);
    });
    return createWithTx(pgliteDriver(db));
  },
};
describeOrgTablePenetration(penetrationEnv);
describeForeignKeyPenetration(penetrationEnv);

// registry 的表與函式（MIL-143）。registry 不掛組織 RLS，隔離靠「app_rw 不能直接碰表」與「函式不分辨別人的 ID 與不存在的 ID」。
describe('registry 的表與函式', () => {
  const REGISTRY_TABLES_SQL = `SELECT n.nspname || '.' || c.relname AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'registry' AND c.relkind IN ('r', 'p') ORDER BY 1`;
  // app_rw 能執行的函式：以 has_function_privilege 判斷，所以觸發器函式（沒有授權）不列入
  const REGISTRY_FUNCTIONS_SQL = `SELECT n.nspname || '.' || p.proname AS name
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'registry' AND has_function_privilege('app_rw', p.oid, 'EXECUTE') ORDER BY 1`;

  const names = async (sql: string) => (await testDb.base.query<{ name: string }>(sql)).rows.map((r) => r.name);

  it('registry 的每張表都登記了案例，也沒有登記不存在的表', async () => {
    const tables = await names(REGISTRY_TABLES_SQL);
    expect(registryTablesWithoutCase(tables), '這些 registry 表沒有案例，請到 src/lib/pg/rls-cases.ts 登記').toEqual([]);
    expect(Object.keys(REGISTRY_TABLE_CASES).filter((t) => !tables.includes(t))).toEqual([]);
  });

  it('app_rw 能執行的每個 registry 函式都登記了案例，也沒有登記不存在的函式', async () => {
    const functions = await names(REGISTRY_FUNCTIONS_SQL);
    expect(registryFunctionsWithoutCase(functions), '這些 registry 函式沒有案例，請到 src/lib/pg/rls-cases.ts 登記').toEqual([]);
    expect(Object.keys(REGISTRY_FUNCTION_CASES).filter((f) => !functions.includes(f))).toEqual([]);
  });

  it.each(Object.keys(REGISTRY_TABLE_CASES))('app_rw 不能直接讀寫 %s', async (table) => {
    const db = await testDb.fresh();
    try {
      await expect(db.query(`SELECT * FROM ${table}`)).rejects.toThrow(/permission denied/);
      await expect(db.query(`DELETE FROM ${table}`)).rejects.toThrow(/permission denied/);
      await expect(db.query(`INSERT INTO ${table} DEFAULT VALUES`)).rejects.toThrow(/permission denied/);
      // 欄位名稱各表不同，UPDATE 改看權限本身：四種權限都沒有，連欄位層級的權限也沒有
      const { rows } = await db.query<{ priv: string; ok: boolean }>(
        `SELECT p AS priv,
                has_table_privilege('app_rw', $1, p)
                  OR (p IN ('SELECT', 'INSERT', 'UPDATE') AND has_any_column_privilege('app_rw', $1, p)) AS ok
           FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p`,
        [table],
      );
      expect(rows.filter((r) => r.ok)).toEqual([]);
    } finally {
      await db.close();
    }
  });

  describeRegistryFunctionPenetration(penetrationEnv);
});
