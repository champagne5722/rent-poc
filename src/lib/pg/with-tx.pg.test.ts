import { Client, Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { pgDriver } from './drivers';
import { fromPgClient } from './executor';
import { migrate } from './migrate';
import { withClusterLock } from './pg-test-support';
import { MIGRATIONS_DIR } from './test-harness';
import { createWithTx } from './with-tx';
import { describeWithTxContract, ORG_A } from './with-tx-contract';

// pg 驅動跑同一組契約測試，對真實 PostgreSQL。只在有 TEST_DATABASE_URL 時執行（見 pg-integration.test.ts）。

const adminUrl = process.env.TEST_DATABASE_URL;

function urlFor(user: string, password: string, db: string): string {
  const u = new URL(adminUrl!);
  u.username = user;
  u.password = password;
  u.pathname = `/${db}`;
  return u.toString();
}

/** 建一個獨立資料庫，跑完 migration，回傳 app_rw 連線池與清理函式。 */
async function createDatabase(poolMax: number) {
  const dbName = `tx_${Math.random().toString(36).slice(2, 10)}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const { username, password } = new URL(adminUrl!);
  const owner = new Client({ connectionString: urlFor(decodeURIComponent(username), decodeURIComponent(password), dbName) });
  await owner.connect();
  await withClusterLock(adminUrl!, async () => {
    await migrate(fromPgClient(owner), { dir: MIGRATIONS_DIR, runAs: 'app_owner' });
    await owner.query(`ALTER ROLE app_rw PASSWORD 'rw-test'`);
  });

  const pool = new Pool({ connectionString: urlFor('app_rw', 'rw-test', dbName), max: poolMax });
  return {
    pool,
    owner,
    close: async () => {
      await pool.end();
      await owner.end();
      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

// 連線池只有一條連線時，每個交易必然重用同一條連線，最能檢驗脈絡外洩
for (const poolMax of [1, 4]) {
  describe.skipIf(!adminUrl)(`pg 連線池 max=${poolMax}`, () => {
    describeWithTxContract(`pg，連線池 ${poolMax} 條`, async () => {
      const dbh = await createDatabase(poolMax);
      return {
        driver: pgDriver(dbh.pool),
        asOwner: async (sql) => {
          await dbh.owner.query(`SET ROLE app_owner; ${sql}; RESET ROLE;`);
        },
        close: dbh.close,
      };
    });
  });
}

describe.skipIf(!adminUrl)('pg 專屬行為', () => {
  it('idle_in_transaction_session_timeout 真的會終止停在交易內的連線，且連線池之後仍可用', async () => {
    const dbh = await createDatabase(1);
    try {
      const withTx = createWithTx(pgDriver(dbh.pool), { idleInTransactionTimeoutMs: 100 });
      await expect(
        withTx({ kind: 'org', orgId: ORG_A }, async (tx) => {
          await tx.query('SELECT 1');
          // 故意違規：模擬 callback 內夾了外部呼叫，驗證伺服器會終止這種交易
          // eslint-disable-next-line no-restricted-syntax
          await new Promise((resolve) => setTimeout(resolve, 600));
          await tx.query('SELECT 2');
        }),
      ).rejects.toThrow();
      // 壞連線已被銷毀，池子開新連線
      const ok = await withTx({ kind: 'control' }, async (tx) => (await tx.query('SELECT 1 AS n')).rows[0]);
      expect(ok).toEqual({ n: 1 });
    } finally {
      await dbh.close();
    }
  });

  it('statement_timeout 真的會取消跑太久的語句，連線之後仍可用（PGlite 不執行逾時，只有 pg 驗得到）', async () => {
    const dbh = await createDatabase(1);
    try {
      const withTx = createWithTx(pgDriver(dbh.pool), { statementTimeoutMs: 100 });
      await expect(withTx({ kind: 'control' }, (tx) => tx.query('SELECT pg_sleep(2)'))).rejects.toThrow(
        /statement timeout/,
      );
      const ok = await withTx({ kind: 'control' }, async (tx) => (await tx.query('SELECT 1 AS n')).rows[0]);
      expect(ok).toEqual({ n: 1 });
    } finally {
      await dbh.close();
    }
  });

  it('預設的 withTx 經 DATABASE_URL 建立連線池並掛在 globalThis，重複呼叫共用同一個', async () => {
    const dbh = await createDatabase(1);
    const saved = process.env.DATABASE_URL;
    const g = globalThis as unknown as { __rentPocPgPool?: Pool; __rentPocTxDriver?: unknown };
    try {
      process.env.DATABASE_URL = urlFor('app_rw', 'rw-test', new URL(dbh.pool.options.connectionString!).pathname.slice(1));
      process.env.PG_POOL_MAX = '2';
      delete g.__rentPocPgPool;
      delete g.__rentPocTxDriver;
      const { withTx } = await import('./database');
      const user = await withTx({ kind: 'control' }, async (tx) => (await tx.query<{ u: string }>('SELECT current_user AS u')).rows[0].u);
      expect(user).toBe('app_rw');
      const pool = g.__rentPocPgPool!;
      expect(pool).toBeDefined();
      expect(pool.options.max).toBe(2);
      await withTx({ kind: 'control' }, async () => 1);
      expect(g.__rentPocPgPool).toBe(pool);
    } finally {
      await g.__rentPocPgPool?.end();
      delete g.__rentPocPgPool;
      delete g.__rentPocTxDriver;
      delete process.env.PG_POOL_MAX;
      if (saved === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved;
      await dbh.close();
    }
  });
});
