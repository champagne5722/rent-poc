import { fileURLToPath } from 'node:url';
import { PGlite, type PGliteInterface } from '@electric-sql/pglite';
import { onTestFinished } from 'vitest';
import { migrate, quoteIdent } from './migrate';

/**
 * vitest 用的 PGlite harness（ADR-0012 決議 13、Action Item 5）。
 *
 * 陷阱：clone() 之後 current_user 會回到 postgres，而 postgres 繞過 RLS，
 * RLS 測試會全部假通過。所以測試一律用 fresh() 取得連線，不要直接呼叫 base.clone()。
 * fresh() 每次都重新 SET ROLE app_rw。
 *
 * 記憶體（MIL-163）：每個副本是一個完整的 PGlite 實例，約佔數十到上百 MB。
 * 副本由 harness 追蹤並關閉，呼叫端不用各自記得關：
 * - 在 test 或 beforeEach 內取得的副本，測試結束後（afterEach 之後）自動關閉。
 * - 在 beforeAll 這類沒有目前測試的位置取得的副本，留到 testDb.close() 關閉。
 * - 呼叫端自己 close() 也可以，副本的 close() 可重複呼叫，已關閉就什麼都不做。
 * 一個測試內同時拿多個副本沒有限制。
 */

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../../db/migrations', import.meta.url));

export const APP_ROLE = 'app_rw';

export interface TestDb {
  /** 已跑完 migration 的母體，身分是 postgres。只用來 clone 與查系統目錄，不要拿來測行為。 */
  base: PGlite;
  /** 隔離的副本，current_user 是 app_rw。測試結束後由 harness 關閉。 */
  fresh(): Promise<PGliteInterface>;
  /** 母體的副本，current_user 是 postgres（繞過 RLS）。給需要超級使用者身分的測試，生命週期同 fresh()。 */
  raw(): Promise<PGliteInterface>;
  /** 關閉母體與所有還開著的副本。 */
  close(): Promise<void>;
}

/** 先等該實例已排隊的查詢跑完再關閉（PGlite issue #1128：關閉時有進行中的語句會讓 CPU 跑滿）。已關閉就略過。 */
async function closeCopy(db: PGliteInterface): Promise<void> {
  if (db.closed) return;
  await db.runExclusive(async () => {});
  if (!db.closed) await db.close();
}

/** 每個測試檔呼叫一次：建一個 PGlite，跑完全部 migration。 */
export async function createTestDb(): Promise<TestDb> {
  const base = new PGlite();
  await base.waitReady;
  await migrate(base, { dir: MIGRATIONS_DIR, runAs: 'app_owner' });

  const copies = new Set<PGliteInterface>();
  /** 登記副本。在測試內取得就掛到該測試的結尾，沒有目前測試就留給 close()。 */
  const track = <T extends PGliteInterface>(db: T): T => {
    copies.add(db);
    // 副本可能已被 harness 在測試結束時關掉，呼叫端稍後（afterAll、kit.close()）再 close() 不該丟錯
    const originalClose = db.close.bind(db);
    db.close = async () => {
      if (!db.closed) await originalClose();
    };
    const release = async () => {
      copies.delete(db);
      await closeCopy(db);
    };
    try {
      onTestFinished(release);
    } catch {
      // 不在測試內（beforeAll 之類），由 close() 收
    }
    return db;
  };

  return {
    base,
    raw: async () => track(await base.clone()),
    fresh: async () => {
      const db = await base.clone();
      track(db);
      await db.exec(`SET ROLE ${quoteIdent(APP_ROLE)}`);
      // 不信任約定，當場確認：current_user 不是 app_rw 就不把連線交出去
      const { rows } = await db.query<{ u: string }>('SELECT current_user AS u');
      if (rows[0].u !== APP_ROLE) throw new Error(`測試連線的 current_user 是 ${rows[0].u}，不是 ${APP_ROLE}`);
      return db;
    },
    close: async () => {
      for (const db of [...copies]) {
        copies.delete(db);
        await closeCopy(db);
      }
      await base.close();
    },
  };
}

/** 暫時換成別的角色做事（建表、授權），做完或丟錯都回到 app_rw。 */
export async function asRole<T>(db: PGliteInterface, role: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${quoteIdent(role)}`);
  try {
    return await fn();
  } finally {
    await db.exec(`SET ROLE ${quoteIdent(APP_ROLE)}`);
  }
}
