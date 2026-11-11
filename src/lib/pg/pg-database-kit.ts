import { Client, Pool, type PoolClient, type PoolConfig } from 'pg';
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

// MIL-218：測試收尾的共用寫法。pg-pool 的 end() 在連線的 socket 真的關閉前就 resolve。
// 此時立刻 DROP DATABASE ... WITH (FORCE)，閒置連線會收到 57P01，Pool 沒有 error 監聽器，
// 錯誤變成 uncaught exception，讓 CI 的 check 偶發失敗。所有測試必須用下面三個函式建 Pool、
// 關 Pool 與刪庫，不得自己寫 new Pool 或刪庫的 SQL（pg-test-teardown.guard.test.ts 會擋）。

const closedClients = new WeakMap<Pool, Promise<void>[]>();
const poolErrors = new WeakMap<Pool, Error[]>();

/** 建立測試用的 Pool：掛上 error 監聽器，並記下每條連線何時真的關閉。 */
export function createTestPool(config: PoolConfig): Pool {
  const pool = new Pool(config);
  const errors: Error[] = [];
  const closed: Promise<void>[] = [];
  poolErrors.set(pool, errors);
  closedClients.set(pool, closed);
  pool.on('error', (err) => {
    errors.push(err);
  });
  pool.on('connect', (client: PoolClient) => {
    closed.push(new Promise<void>((resolve) => client.once('end', () => resolve())));
  });
  return pool;
}

/** 讀出 Pool 的 error 監聽器收到的錯誤。 */
export function testPoolErrors(pool: Pool): readonly Error[] {
  return poolErrors.get(pool) ?? [];
}

/**
 * 關閉 Pool，並等全部連線的 socket 真的關閉。之後才能刪除資料庫。
 * 不是 createTestPool 建的 Pool（例如正式程式掛在 globalThis 的 Pool）沒有追蹤紀錄，
 * 這時用 pg-pool 的 _clients 在 end() 之前取一份快照。
 */
export async function closeTestPool(pool: Pool): Promise<void> {
  const waits = [...(closedClients.get(pool) ?? [])];
  const live = (pool as unknown as { _clients?: PoolClient[] })._clients;
  for (const client of live ?? []) waits.push(new Promise<void>((resolve) => client.once('end', () => resolve())));
  await pool.end();
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 10_000).unref());
  await Promise.race([Promise.all(waits).then(() => undefined), timeout]);
}

/** 刪除測試用資料庫。呼叫前必須先用 closeTestPool 關掉自己的 Pool。 */
export async function dropTestDatabase(adminUrl: string, dbName: string): Promise<void> {
  const root = new Client({ connectionString: adminUrl });
  await root.connect();
  try {
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  } finally {
    await root.end();
  }
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

  const pool = createTestPool({ connectionString: urlFor('app_rw', 'rw-test', dbName), max: poolMax });
  return {
    pool,
    owner,
    close: async () => {
      await closeTestPool(pool);
      await owner.end();
      await dropTestDatabase(adminUrl, dbName);
    },
  };
}
