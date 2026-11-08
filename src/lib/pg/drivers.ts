import { Pool, type PoolConfig } from 'pg';
import type { PGliteInterface } from '@electric-sql/pglite';
import { fromPgClient, type TxDriver } from './executor';

// 驅動 adapter：pg 與 PGlite 各一個，通過同一組契約測試（with-tx-contract.ts）。

// ---------------------------------------------------------------------------
// pg

/** 預設連線池上限。Cloud SQL 的 db-f1-micro 連線數低，實際數字由 MIL-92 實測後調整。 */
export const DEFAULT_POOL_MAX = 5;

export function pgPoolConfig(env: Readonly<Record<string, string | undefined>> = process.env): PoolConfig {
  const connectionString = env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('缺少環境變數 DATABASE_URL，無法連線資料庫');
  const max = env.PG_POOL_MAX ? Number(env.PG_POOL_MAX) : DEFAULT_POOL_MAX;
  if (!Number.isInteger(max) || max < 1) throw new Error('PG_POOL_MAX 必須是正整數');
  return {
    connectionString,
    max,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  };
}

export function pgDriver(pool: Pool): TxDriver {
  return {
    async acquire() {
      const client = await pool.connect();
      // pool 只替閒置的連線接 error 事件。借出期間伺服器端砍連線（例如 idle-in-transaction 逾時），
      // 沒有監聽器的話 error 會變成未捕捉例外讓程序崩潰。進行中的查詢本來就會因此 reject
      const onError = (error: Error) => console.error('[pg] 借出的連線發生錯誤', error.message);
      client.on('error', onError);
      return {
        conn: fromPgClient(client),
        release: (broken) => {
          client.off('error', onError);
          // true 會銷毀這條連線，不放回連線池
          client.release(broken);
        },
      };
    },
    close: () => pool.end(),
  };
}

// 連線池掛在 globalThis：Next.js dev 模式下模組可能被多次載入，不掛的話每次重載都多一個池
const globalForPool = globalThis as unknown as { __rentPocPgPool?: Pool };

/** 應用程式共用的連線池，第一次用到才建立。連線身分由 DATABASE_URL 決定，必須是 app_rw。 */
export function getPgPool(): Pool {
  if (!globalForPool.__rentPocPgPool) {
    const pool = new Pool(pgPoolConfig());
    // 閒置連線被伺服器關閉時 pool 會發 error 事件，沒人接會讓整個程序崩潰
    pool.on('error', (error) => console.error('[pg] 閒置連線發生錯誤', error));
    globalForPool.__rentPocPgPool = pool;
  }
  return globalForPool.__rentPocPgPool;
}

// ---------------------------------------------------------------------------
// PGlite

/**
 * PGlite 只有一條連線，交易之間必須排隊，否則兩個 BEGIN 會交錯。
 * 傳進來的實例必須已經 SET ROLE app_rw（test-harness 的 fresh() 做了這件事）。
 */
export function pgliteDriver(db: PGliteInterface): TxDriver {
  let tail: Promise<void> = Promise.resolve();
  return {
    acquire() {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      return previous.then(() => ({ conn: db, release: () => release() }));
    },
    close: () => db.close(),
  };
}
