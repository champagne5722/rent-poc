import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from './migrate';
import { asRole, createTestDb, MIGRATIONS_DIR, type TestDb } from './test-harness';

// MIL-79：五區 schema、角色、權限、種子。
// 只驗外部行為（以 app_rw 身分能不能做某件事）加 ADR-0012 明列的系統目錄約束。

describe('PostgreSQL 骨架', () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
  });
  afterAll(() => testDb.close());

  describe('schema 與角色', () => {
    it('五區 schema 都存在', async () => {
      const { rows } = await testDb.base.query<{ nspname: string }>(
        `SELECT nspname FROM pg_namespace WHERE nspname IN ('org','registry','audit','vault','control') ORDER BY 1`,
      );
      expect(rows.map((r) => r.nspname)).toEqual(['audit', 'control', 'org', 'registry', 'vault']);
    });

    it('角色的登入屬性：app_owner 與 app_rw 可登入，其餘不可', async () => {
      const { rows } = await testDb.base.query<{ rolname: string; rolcanlogin: boolean }>(
        `SELECT rolname, rolcanlogin FROM pg_roles
          WHERE rolname IN ('app_owner','app_rw','audit_owner','vault_owner','break_glass') ORDER BY 1`,
      );
      expect(rows).toEqual([
        { rolname: 'app_owner', rolcanlogin: true },
        { rolname: 'app_rw', rolcanlogin: true },
        { rolname: 'audit_owner', rolcanlogin: false },
        { rolname: 'break_glass', rolcanlogin: false },
        { rolname: 'vault_owner', rolcanlogin: false },
      ]);
    });

    it('ADR-0012 陷阱 1：除了 break_glass，沒有任何應用角色是 superuser 或 BYPASSRLS', async () => {
      const { rows } = await testDb.base.query<{ rolname: string }>(
        `SELECT rolname FROM pg_roles
          WHERE rolname IN ('app_owner','app_rw','audit_owner','vault_owner')
            AND (rolsuper OR rolbypassrls)`,
      );
      expect(rows).toEqual([]);
    });

    it('PGlite 以 superuser 執行時，break_glass 有 BYPASSRLS', async () => {
      const { rows } = await testDb.base.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
        `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'break_glass'`,
      );
      expect(rows[0]).toEqual({ rolbypassrls: true, rolsuper: false });
    });

    it('app_owner 能 SET 成 audit_owner 與 vault_owner，app_rw 不能 SET 成任何擁有者', async () => {
      const { rows } = await testDb.base.query<{ who: string; target: string; ok: boolean }>(
        `SELECT m AS who, t AS target, pg_has_role(m, t, 'SET') AS ok
           FROM (VALUES ('app_owner','audit_owner'), ('app_owner','vault_owner'),
                        ('app_rw','app_owner'), ('app_rw','audit_owner'), ('app_rw','vault_owner'),
                        ('app_rw','break_glass')) AS v(m, t)`,
      );
      expect(rows.map((r) => [r.who, r.target, r.ok])).toEqual([
        ['app_owner', 'audit_owner', true],
        ['app_owner', 'vault_owner', true],
        ['app_rw', 'app_owner', false],
        ['app_rw', 'audit_owner', false],
        ['app_rw', 'vault_owner', false],
        ['app_rw', 'break_glass', false],
      ]);
    });

    it('五區 schema 的擁有者：audit 與 vault 由各自的 NOLOGIN 角色擁有，其餘 app_owner', async () => {
      const { rows } = await testDb.base.query<{ nspname: string; owner: string }>(
        `SELECT n.nspname, pg_get_userbyid(n.nspowner) AS owner FROM pg_namespace n
          WHERE nspname IN ('org','registry','audit','vault','control') ORDER BY 1`,
      );
      expect(rows.map((r) => [r.nspname, r.owner])).toEqual([
        ['audit', 'audit_owner'],
        ['control', 'app_owner'],
        ['org', 'app_owner'],
        ['registry', 'app_owner'],
        ['vault', 'vault_owner'],
      ]);
    });
  });

  describe('app_rw 的權限', () => {
    it.each([
      ['registry', 'app_owner'],
      ['audit', 'audit_owner'],
      ['vault', 'vault_owner'],
    ])('直接查 %s 的表被拒', async (schema, owner) => {
      const db = await testDb.fresh();
      try {
        await asRole(db, owner, () => db.exec(`CREATE TABLE ${schema}.probe (id int)`));
        await expect(db.query(`SELECT * FROM ${schema}.probe`)).rejects.toThrow(/permission denied/);
        await expect(db.query(`INSERT INTO ${schema}.probe VALUES (1)`)).rejects.toThrow(/permission denied/);
      } finally {
        await db.close();
      }
    });

    it('registry、audit、vault 的函式預設不開放給 PUBLIC，要明確 GRANT 才能呼叫', async () => {
      const db = await testDb.fresh();
      try {
        await asRole(db, 'audit_owner', () =>
          db.exec(`CREATE FUNCTION audit.probe() RETURNS int LANGUAGE sql AS 'SELECT 1'`),
        );
        await expect(db.query('SELECT audit.probe()')).rejects.toThrow(/permission denied/);
        await asRole(db, 'audit_owner', () => db.exec('GRANT EXECUTE ON FUNCTION audit.probe() TO app_rw'));
        const { rows } = await db.query<{ v: number }>('SELECT audit.probe() AS v');
        expect(rows[0].v).toBe(1);
      } finally {
        await db.close();
      }
    });

    it('control：新表預設沒有任何權限，要逐表授予', async () => {
      const db = await testDb.fresh();
      try {
        await asRole(db, 'app_owner', () => db.exec('CREATE TABLE control.probe (id int)'));
        await expect(db.query('SELECT * FROM control.probe')).rejects.toThrow(/permission denied/);
        await asRole(db, 'app_owner', () => db.exec('GRANT SELECT ON control.probe TO app_rw'));
        await expect(db.query('SELECT * FROM control.probe')).resolves.toBeDefined();
        await expect(db.query('INSERT INTO control.probe VALUES (1)')).rejects.toThrow(/permission denied/);
      } finally {
        await db.close();
      }
    });

    it('control：其他線的 migration 能自建表並自行 REVOKE 與 GRANT（F 線 control.handovers 的情境）', async () => {
      const db = await testDb.base.clone();
      try {
        const combined = await copyWithExtra(
          '9000_handovers.sql',
          `CREATE TABLE control.handovers (id text PRIMARY KEY, state text NOT NULL);
           REVOKE ALL ON control.handovers FROM PUBLIC;
           GRANT SELECT ON control.handovers TO app_rw;`,
        );
        try {
          expect(await migrate(db, { dir: combined, runAs: 'app_owner' })).toEqual(['9000_handovers.sql']);
        } finally {
          await rm(combined, { recursive: true, force: true });
        }
        await db.exec('SET ROLE app_rw');
        await expect(db.query('SELECT * FROM control.handovers')).resolves.toBeDefined();
        await expect(db.query("INSERT INTO control.handovers VALUES ('x', 'y')")).rejects.toThrow(
          /permission denied/,
        );
        const { rows } = await db.query<{ owner: string }>(
          `SELECT tableowner AS owner FROM pg_tables WHERE tablename = 'handovers'`,
        );
        expect(rows[0].owner).toBe('app_owner');
      } finally {
        await db.close();
      }
    });

    it('control.schema_migrations 對 app_rw 不可見', async () => {
      const db = await testDb.fresh();
      try {
        await expect(db.query('SELECT * FROM control.schema_migrations')).rejects.toThrow(/permission denied/);
      } finally {
        await db.close();
      }
    });

    it('org：app_owner 建的表，app_rw 預設有 DML', async () => {
      const db = await testDb.fresh();
      try {
        await asRole(db, 'app_owner', () => db.exec('CREATE TABLE org.probe (id int)'));
        await db.exec('INSERT INTO org.probe VALUES (1)');
        const { rows } = await db.query('SELECT * FROM org.probe');
        expect(rows).toHaveLength(1);
      } finally {
        await db.close();
      }
    });

    it('app_rw 不能在任何一區建立物件', async () => {
      const db = await testDb.fresh();
      try {
        for (const schema of ['org', 'registry', 'audit', 'vault', 'control']) {
          await expect(db.exec(`CREATE TABLE ${schema}.sneaky (id int)`)).rejects.toThrow(/permission denied/);
        }
      } finally {
        await db.close();
      }
    });
  });

  describe('種子', () => {
    it('有一個平台組織與一個預設組織', async () => {
      const db = await testDb.fresh();
      try {
        const { rows } = await db.query<{ kind: string }>('SELECT kind FROM control.orgs ORDER BY kind');
        expect(rows.map((r) => r.kind)).toEqual(['owner', 'platform']);
      } finally {
        await db.close();
      }
    });

    it('預設組織不是執業主體，且 orgs 沒有其他必填欄位，C 線轉成屋主組織只需 UPDATE 與新增成員', async () => {
      const { rows } = await testDb.base.query<{ kind: string }>(
        `SELECT kind FROM control.orgs WHERE kind <> 'platform'`,
      );
      expect(rows).toEqual([{ kind: 'owner' }]);
      const required = await testDb.base.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'control' AND table_name = 'orgs'
            AND is_nullable = 'NO' AND column_default IS NULL ORDER BY 1`,
      );
      expect(required.rows.map((r) => r.column_name)).toEqual(['id', 'kind', 'name']);
      const db = await testDb.base.clone();
      try {
        await db.exec(`UPDATE control.orgs SET name = '某屋主' WHERE kind = 'owner'`);
        const renamed = await db.query<{ name: string }>(`SELECT name FROM control.orgs WHERE kind = 'owner'`);
        expect(renamed.rows[0].name).toBe('某屋主');
      } finally {
        await db.close();
      }
    });

    it('平台組織只能有一個', async () => {
      const db = await testDb.base.clone();
      try {
        await expect(
          db.exec(`INSERT INTO control.orgs (id, name, kind) VALUES ('00000000000000000000000003', '第二個', 'platform')`),
        ).rejects.toThrow(/duplicate key|unique/i);
      } finally {
        await db.close();
      }
    });

    it('組織 ID 必須是 ULID 格式', async () => {
      const db = await testDb.base.clone();
      try {
        await expect(
          db.exec(`INSERT INTO control.orgs (id, name, kind) VALUES ('12', '壞 ID', 'owner')`),
        ).rejects.toThrow(/check|violates/i);
      } finally {
        await db.close();
      }
    });

    it('app_rw 能讀組織，但不能直接寫', async () => {
      const db = await testDb.fresh();
      try {
        await expect(db.query('SELECT id FROM control.orgs')).resolves.toBeDefined();
        await expect(db.exec(`UPDATE control.orgs SET name = 'x'`)).rejects.toThrow(/permission denied/);
      } finally {
        await db.close();
      }
    });
  });

  describe('migration 紀錄', () => {
    it('重跑同一個目錄不會再執行任何檔案', async () => {
      const db = await testDb.base.clone();
      try {
        expect(await migrate(db, { dir: MIGRATIONS_DIR, runAs: 'app_owner' })).toEqual([]);
      } finally {
        await db.close();
      }
    });
  });
});

// A 線的 migration 目錄加上另一條線的檔案，模擬整合後的目錄
async function copyWithExtra(name: string, sql: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'combined-'));
  await cp(MIGRATIONS_DIR, dir, { recursive: true });
  await writeFile(path.join(dir, name), sql);
  return dir;
}
