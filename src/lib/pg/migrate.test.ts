import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fromPgClient } from './executor';
import { migrate, type SqlExecutor } from './migrate';

// migration runner 的契約測試：PGlite 與 pg 驅動共用同一組案例（MIL-79）。
// pg 那組需要真實 PostgreSQL，由 TEST_DATABASE_URL 開啟（CI 的 check job 有容器）。

interface Env {
  db: SqlExecutor;
  /** 同一個資料庫再開一條獨立連線，用來測兩個程序同時 migrate */
  second?: () => Promise<{ db: SqlExecutor; close: () => Promise<void> }>;
  close: () => Promise<void>;
}

async function writeSql(dir: string, files: Record<string, string>) {
  for (const [name, sql] of Object.entries(files)) await writeFile(path.join(dir, name), sql);
}

function runnerContract(label: string, open: () => Promise<Env>, opts: { concurrent: boolean }) {
  describe(`migration runner（${label}）`, () => {
    let dir: string;
    let env: Env;

    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'migrations-'));
      env = await open();
    });
    afterEach(async () => {
      await env.close();
      await rm(dir, { recursive: true, force: true });
    });

    it('依檔名順序執行，第二次執行不重跑', async () => {
      await writeSql(dir, {
        '0002_b.sql': 'CREATE TABLE t_b (id int);',
        '0001_a.sql': 'CREATE TABLE t_a (id int);',
      });
      expect(await migrate(env.db, { dir })).toEqual(['0001_a.sql', '0002_b.sql']);
      // CREATE TABLE 沒有 IF NOT EXISTS，重跑會報錯，所以回傳空陣列代表真的沒重跑
      expect(await migrate(env.db, { dir })).toEqual([]);
    });

    it('一個檔案可以含多條語句與函式本體', async () => {
      await writeSql(dir, {
        '0001_multi.sql': `
          CREATE TABLE t1 (id int);
          CREATE TABLE t2 (id int);
          CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1; $$;
          INSERT INTO t1 VALUES (1), (2);`,
      });
      await migrate(env.db, { dir });
      const { rows } = await env.db.query<{ n: number; f: number }>(
        'SELECT (SELECT count(*)::int FROM t1) AS n, f() AS f',
      );
      expect(rows[0]).toEqual({ n: 2, f: 1 });
    });

    it('已執行的檔案被改動時報錯，且不再往後執行', async () => {
      await writeSql(dir, { '0001_a.sql': 'CREATE TABLE t_a (id int);' });
      await migrate(env.db, { dir });
      await writeSql(dir, {
        '0001_a.sql': 'CREATE TABLE t_a (id int, extra text);',
        '0002_b.sql': 'CREATE TABLE t_b (id int);',
      });
      await expect(migrate(env.db, { dir })).rejects.toThrow(/0001_a\.sql.*已被修改/);
      const { rows } = await env.db.query("SELECT to_regclass('t_b') AS t");
      expect(rows[0]).toEqual({ t: null });
    });

    it('已執行的檔案從目錄消失時報錯', async () => {
      await writeSql(dir, { '0001_a.sql': 'CREATE TABLE t_a (id int);' });
      await migrate(env.db, { dir });
      await rm(path.join(dir, '0001_a.sql'));
      await expect(migrate(env.db, { dir })).rejects.toThrow(/0001_a\.sql.*不存在/);
    });

    it('檔案中途失敗時整個檔案回滾，修好後可重跑', async () => {
      await writeSql(dir, {
        '0001_bad.sql': 'CREATE TABLE t_half (id int); SELECT 1/0;',
      });
      await expect(migrate(env.db, { dir })).rejects.toThrow(/0001_bad\.sql/);
      const half = await env.db.query("SELECT to_regclass('t_half') AS t");
      expect(half.rows[0]).toEqual({ t: null });

      await writeSql(dir, { '0001_bad.sql': 'CREATE TABLE t_half (id int);' });
      expect(await migrate(env.db, { dir })).toEqual(['0001_bad.sql']);
    });

    it('檔案自己寫 BEGIN 或 COMMIT 時拒絕執行', async () => {
      await writeSql(dir, { '0001_tx.sql': 'BEGIN; CREATE TABLE t (id int); COMMIT;' });
      await expect(migrate(env.db, { dir })).rejects.toThrow(/0001_tx\.sql.*交易/);
    });

    it('檔名不合 NNNN_name.sql 時報錯，非 .sql 檔案忽略', async () => {
      await writeSql(dir, { 'README.md': '# x', 'oops.sql': 'SELECT 1;' });
      await expect(migrate(env.db, { dir })).rejects.toThrow(/oops\.sql.*檔名/);
      await rm(path.join(dir, 'oops.sql'));
      expect(await migrate(env.db, { dir })).toEqual([]);
    });

    it('runAs：角色存在後，後續檔案建的物件由該角色擁有', async () => {
      const role = `runner_owner_${Math.random().toString(36).slice(2, 8)}`;
      await writeSql(dir, {
        '0001_role.sql': `
          CREATE ROLE ${role} NOLOGIN;
          GRANT CREATE ON SCHEMA public TO ${role};
          CREATE TABLE made_before_role (id int);`,
        '0002_table.sql': 'CREATE TABLE made_by_role (id int);',
      });
      await migrate(env.db, { dir, runAs: role });
      const { rows } = await env.db.query<{ tablename: string; tableowner: string }>(
        `SELECT tablename, tableowner FROM pg_tables
          WHERE tablename IN ('made_before_role', 'made_by_role')`,
      );
      expect(rows.find((r) => r.tablename === 'made_by_role')?.tableowner).toBe(role);
      expect(rows.find((r) => r.tablename === 'made_before_role')?.tableowner).not.toBe(role);
    });

    it('同一個程序同時呼叫兩次，只執行一次', async () => {
      await writeSql(dir, { '0001_a.sql': 'CREATE TABLE t_a (id int);' });
      const [x, y] = await Promise.all([migrate(env.db, { dir }), migrate(env.db, { dir })]);
      expect([...x, ...y]).toEqual(['0001_a.sql']);
    });

    it.skipIf(!opts.concurrent)('兩條連線同時 migrate，由 advisory lock 排隊', async () => {
      await writeSql(dir, {
        // 沒有 IF NOT EXISTS：沒有排隊的話第二條連線會撞到已存在的表而失敗
        '0001_slow.sql': 'SELECT pg_sleep(1); CREATE TABLE t_slow (id int);',
        '0002_next.sql': 'CREATE TABLE t_next (id int);',
      });
      const other = await env.second!();
      try {
        const [x, y] = await Promise.all([migrate(env.db, { dir }), migrate(other.db, { dir })]);
        expect([...x, ...y].sort()).toEqual(['0001_slow.sql', '0002_next.sql']);
        expect([x.length, y.length].sort()).toEqual([0, 2]);
      } finally {
        await other.close();
      }
    });
  });
}

runnerContract(
  'PGlite',
  async () => {
    const db = new PGlite();
    await db.waitReady;
    return { db, close: () => db.close() };
  },
  { concurrent: false },
);

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('migration runner 的 pg 驅動環境', () => {
  const adminUrl = databaseUrl!;
  const dbName = `mig_${Math.random().toString(36).slice(2, 10)}`;

  const withAdmin = async (sql: string) => {
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(sql);
    } finally {
      await admin.end();
    }
  };

  const connect = async (): Promise<{ db: SqlExecutor; close: () => Promise<void> }> => {
    const url = new URL(adminUrl);
    url.pathname = `/${dbName}`;
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    return { db: fromPgClient(client), close: () => client.end() };
  };

  // 外層 beforeEach 先建庫，內層 runnerContract 的 beforeEach 再連線
  beforeEach(() => withAdmin(`CREATE DATABASE ${dbName}`));
  afterEach(() => withAdmin(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`));

  runnerContract(
    'pg',
    async () => {
      const first = await connect();
      return { db: first.db, second: connect, close: first.close };
    },
    { concurrent: true },
  );
});
