import { Client } from 'pg';

// 真實 PostgreSQL 測試的共用工具。只給 *.test.ts 使用。

const CLUSTER_LOCK_KEY = '7940002'; // 任意固定值，與 migrate.ts 的 LOCK_KEY 不同

/**
 * 角色是整個叢集共用的。vitest 並行跑多個測試檔時，兩個檔案同時建立角色、授權或 ALTER ROLE，
 * PostgreSQL 會報「tuple concurrently updated」。所有動到角色的步驟都包在這個鎖裡。
 */
export async function withClusterLock<T>(adminUrl: string, fn: () => Promise<T>): Promise<T> {
  const locker = new Client({ connectionString: adminUrl });
  await locker.connect();
  try {
    await locker.query('SELECT pg_advisory_lock($1::bigint)', [CLUSTER_LOCK_KEY]);
    return await fn();
  } finally {
    await locker.end(); // 連線結束時鎖自動釋放
  }
}
