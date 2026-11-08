import type { Client } from 'pg';

/**
 * migration runner 與測試 harness 共用的最小驅動介面（ADR-0012 決議 15）。
 * PGlite 的實例本身就符合這個形狀；pg 的 Client 用 fromPgClient 包一層。
 *
 * exec：可含多條語句，不帶參數。query：單一語句，可帶參數。
 */
export interface SqlExecutor {
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** pg 的 Client 不帶參數時走 simple query protocol，所以能一次送多條語句。 */
export function fromPgClient(client: Client): SqlExecutor {
  return {
    exec: (sql) => client.query(sql),
    query: async <T>(sql: string, params?: unknown[]) => {
      const result = await client.query(sql, params);
      return { rows: result.rows as T[] };
    },
  };
}
