import { fileURLToPath } from 'node:url';
import { PGlite, type PGliteInterface } from '@electric-sql/pglite';
import { migrate } from './migrate';

/**
 * vitest 用的 PGlite harness（ADR-0012 決議 13、Action Item 5）。
 *
 * 陷阱：clone() 之後 current_user 會回到 postgres，而 postgres 繞過 RLS，
 * RLS 測試會全部假通過。所以測試一律用 fresh() 取得連線，不要直接呼叫 base.clone()。
 * fresh() 每次都重新 SET ROLE app_rw。
 */

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../../db/migrations', import.meta.url));

export const APP_ROLE = 'app_rw';

export interface TestDb {
  /** 已跑完 migration 的母體，身分是 postgres。只用來 clone 與查系統目錄，不要拿來測行為。 */
  base: PGlite;
  /** 隔離的副本，current_user 是 app_rw。 */
  fresh(): Promise<PGliteInterface>;
  close(): Promise<void>;
}

/** 每個測試檔呼叫一次：建一個 PGlite，跑完全部 migration。 */
export async function createTestDb(): Promise<TestDb> {
  const base = new PGlite();
  await base.waitReady;
  await migrate(base, { dir: MIGRATIONS_DIR, runAs: 'app_owner' });
  return {
    base,
    fresh: async () => {
      const db = await base.clone();
      await db.exec(`SET ROLE ${APP_ROLE}`);
      return db;
    },
    close: () => base.close(),
  };
}

/** 暫時換成別的角色做事（建表、授權），做完或丟錯都回到 app_rw。 */
export async function asRole<T>(db: PGliteInterface, role: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE "${role}"`);
  try {
    return await fn();
  } finally {
    await db.exec(`SET ROLE ${APP_ROLE}`);
  }
}
