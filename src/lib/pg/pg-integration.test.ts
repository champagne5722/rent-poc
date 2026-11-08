import { PGlite } from '@electric-sql/pglite';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromPgClient } from './executor';
import { migrate } from './migrate';
import { MIGRATIONS_DIR } from './test-harness';

// 真實 PostgreSQL 的整合測試（ADR-0012 決議 13：CI 另開真實容器跑角色檢查）。
// 只在有 TEST_DATABASE_URL 時執行。本機：docker run -p 54329:5432 -e POSTGRES_PASSWORD=pw postgres:18
// 然後 TEST_DATABASE_URL=postgres://postgres:pw@localhost:54329/postgres npx vitest run

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('真實 PostgreSQL', () => {
  const dbName = `it_${Math.random().toString(36).slice(2, 10)}`;
  const urlFor = (user: string, password: string, db: string) => {
    const u = new URL(adminUrl!);
    u.username = user;
    u.password = password;
    u.pathname = `/${db}`;
    return u.toString();
  };
  let owner: Client; // 以管理者身分連到測試用資料庫
  let applied: string[];

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    owner = new Client({ connectionString: urlFor(new URL(adminUrl!).username, new URL(adminUrl!).password, dbName) });
    await owner.connect();
    applied = await migrate(fromPgClient(owner), { dir: MIGRATIONS_DIR, runAs: 'app_owner' });
  });
  afterAll(async () => {
    await owner.end();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it('主版本與 PGlite 回報的一致（CI 容器要和測試環境對齊）', async () => {
    const major = async (db: { query: (s: string) => Promise<{ rows: Record<string, string>[] }> }) =>
      Math.floor(Number((await db.query('SHOW server_version_num')).rows[0].server_version_num) / 10000);
    const lite = new PGlite();
    try {
      expect(await major(owner)).toBe(await major(lite));
    } finally {
      await lite.close();
    }
  });

  it('全部 migration 在 pg 上執行成功，重跑不再執行', async () => {
    expect(applied.length).toBeGreaterThanOrEqual(2);
    expect(await migrate(fromPgClient(owner), { dir: MIGRATIONS_DIR, runAs: 'app_owner' })).toEqual([]);
  });

  it('以 app_rw 真實登入後：current_user 正確、讀得到 control.orgs、直接查其他區的表被拒', async () => {
    await owner.query(`ALTER ROLE app_rw PASSWORD 'rw-test'`);
    // 其他區的表由各自的擁有者建立
    await owner.query(`SET ROLE app_owner; CREATE TABLE registry.probe (id int); RESET ROLE;`);
    await owner.query(`SET ROLE audit_owner; CREATE TABLE audit.probe (id int); RESET ROLE;`);
    await owner.query(`SET ROLE vault_owner; CREATE TABLE vault.probe (id int); RESET ROLE;`);

    const rw = new Client({ connectionString: urlFor('app_rw', 'rw-test', dbName) });
    await rw.connect();
    try {
      const who = await rw.query(
        `SELECT current_user AS u, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user`,
      );
      expect(who.rows[0]).toEqual({ u: 'app_rw', rolsuper: false, rolbypassrls: false });
      expect((await rw.query('SELECT kind FROM control.orgs ORDER BY kind')).rows.map((r) => r.kind)).toEqual([
        'owner',
        'platform',
      ]);
      for (const table of ['registry.probe', 'audit.probe', 'vault.probe', 'control.schema_migrations']) {
        await expect(rw.query(`SELECT * FROM ${table}`)).rejects.toThrow(/permission denied/);
      }
    } finally {
      await rw.end();
    }
  });

  it('以 app_owner 真實登入後可以跑 migration（CI 的執行方式）', async () => {
    await owner.query(`ALTER ROLE app_owner PASSWORD 'owner-test'`);
    const client = new Client({ connectionString: urlFor('app_owner', 'owner-test', dbName) });
    await client.connect();
    try {
      expect(await migrate(fromPgClient(client), { dir: MIGRATIONS_DIR, runAs: 'app_owner' })).toEqual([]);
    } finally {
      await client.end();
    }
  });
});
