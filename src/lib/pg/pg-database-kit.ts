import { Client, Pool } from 'pg';
import { fromPgClient } from './executor';
import { migrate } from './migrate';
import { withClusterLock } from './pg-test-support';
import { MIGRATIONS_DIR } from './test-harness';

// 真實 PostgreSQL 測試用：建一個獨立資料庫，跑完全部 migration，回傳 app_rw 的連線池。
// 只給 *.pg.test.ts 使用，且只在有 TEST_DATABASE_URL 時才能呼叫。多個測試檔並行時，
// 動到角色的步驟靠 withClusterLock 排隊（見 pg-test-support.ts）。

export interface PgTestDatabase {
  /** 連線身分是 app_rw。 */
  pool: Pool;
  /** 連線身分是管理者，只用來觀察 app_rw 看不到的表與建測試資料。 */
  owner: Client;
  close(): Promise<void>;
}

export async function createPgTestDatabase(adminUrl: string, poolMax: number): Promise<PgTestDatabase> {
  const urlFor = (user: string, password: string, db: string) => {
    const u = new URL(adminUrl);
    u.username = user;
    u.password = password;
    u.pathname = `/${db}`;
    return u.toString();
  };
  const dbName = `kit_${Math.random().toString(36).slice(2, 10)}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const { username, password } = new URL(adminUrl);
  const owner = new Client({ connectionString: urlFor(decodeURIComponent(username), decodeURIComponent(password), dbName) });
  await owner.connect();
  await withClusterLock(adminUrl, async () => {
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
