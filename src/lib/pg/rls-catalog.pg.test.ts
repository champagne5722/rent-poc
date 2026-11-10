import { describe } from 'vitest';
import { createPgTestDatabase } from './pg-database-kit';
import { describeRlsCatalog } from './rls-catalog-suite';

// 系統目錄檢查，真實 PostgreSQL 版（MIL-89，驗收條件 1 到 6、13）。只在有 TEST_DATABASE_URL 時執行。
// CI 的 check 工作必須保證它真的跑到（scripts/ci/check-pg-tests-ran.mjs）。
const adminUrl = process.env.TEST_DATABASE_URL;

if (!adminUrl) {
  describe.skip('系統目錄檢查：真實 PostgreSQL', () => {});
} else {
  describeRlsCatalog('真實 PostgreSQL', async () => {
    // owner 連線是管理者身分（通常是 superuser），檢查與故意違規的 DDL 都走這條
    const dbh = await createPgTestDatabase(adminUrl, 1);
    return {
      q: async (sql, params) => (await dbh.owner.query(sql, params)).rows as never,
      exec: async (sql) => {
        await dbh.owner.query(sql);
      },
      close: () => dbh.close(),
    };
  });
}
