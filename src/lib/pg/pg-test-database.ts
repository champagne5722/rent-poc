import { Client } from 'pg';
import { withClusterLock } from './pg-test-support';

// 真實 PostgreSQL 測試用的獨立資料庫（MIL-89）。每個測試檔建自己的資料庫，跑完刪除，檔案之間互不影響。

/** 把 TEST_DATABASE_URL 換成指定的使用者、密碼與資料庫。 */
export function urlFor(adminUrl: string, user: string, password: string, db: string): string {
  const u = new URL(adminUrl);
  u.username = user;
  u.password = password;
  u.pathname = `/${db}`;
  return u.toString();
}

export interface MigratedDatabase {
  dbName: string;
  /** 管理者身分（TEST_DATABASE_URL 的使用者，通常是 superuser）的連線，連到這個資料庫。 */
  admin: Client;
  /** app_rw 的連線字串，密碼是 'rw-test'。 */
  appRwUrl: string;
  /** 關閉連線並刪除資料庫。 */
  close(): Promise<void>;
}

/**
 * 建一個獨立資料庫，跑完全部 migration，並給 app_rw 設密碼。
 * 動到角色的步驟包在叢集鎖內（見 withClusterLock）。呼叫端必須呼叫 close()。
 */
export async function createMigratedDatabase(
  adminUrl: string,
  migrateAll: (admin: Client) => Promise<unknown>,
  prefix = 'db',
): Promise<MigratedDatabase> {
  const dbName = `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
  const root = new Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  await root.end();

  const { username, password } = new URL(adminUrl);
  const admin = new Client({ connectionString: urlFor(adminUrl, decodeURIComponent(username), decodeURIComponent(password), dbName) });
  await admin.connect();
  await withClusterLock(adminUrl, async () => {
    await migrateAll(admin);
    await admin.query(`ALTER ROLE app_rw PASSWORD 'rw-test'`);
  });
  return {
    dbName,
    admin,
    appRwUrl: urlFor(adminUrl, 'app_rw', 'rw-test', dbName),
    close: async () => {
      await admin.end();
      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}
