import { getPgPool, pgDriver } from './drivers';
import type { TxDriver } from './executor';
import { createWithTx, type DbContext, type Tx } from './with-tx';

// 應用程式取得資料庫的入口（ADR-0012 決議 10）。
// 預設驅動是 pg 連線池，第一次呼叫才建立，連線字串讀 DATABASE_URL。
// 測試用 useTxDriver() 換成 PGlite，用完呼叫 useTxDriver(undefined) 復原。

// 覆寫也掛在 globalThis：dev 模式模組重載時，覆寫與連線池不會分家
const globalForDriver = globalThis as unknown as { __rentPocTxDriver?: TxDriver; __rentPocTxOverride?: TxDriver };

export function useTxDriver(driver: TxDriver | undefined): void {
  globalForDriver.__rentPocTxOverride = driver;
}

function currentDriver(): TxDriver {
  if (globalForDriver.__rentPocTxOverride) return globalForDriver.__rentPocTxOverride;
  return (globalForDriver.__rentPocTxDriver ??= pgDriver(getPgPool()));
}

/**
 * 取得資料庫的唯一入口。ctx 決定組織脈絡，tx 的型別標記跟著 ctx.kind。
 * 規則（callback 內不得有外部 API 呼叫、不得巢狀、例外即回滾）見 with-tx.ts 檔頭。
 */
export function withTx<C extends DbContext, R>(ctx: C, fn: (tx: Tx<C['kind']>) => Promise<R>): Promise<R> {
  // 兩個逾時由 withTx 以 SET LOCAL 隨 BEGIN 一起送出，使用預設值，呼叫端不得覆寫
  return createWithTx(currentDriver())(ctx, fn);
}
