import { describe } from 'vitest';
import { fromPgClient } from './executor';
import { migrate } from './migrate';
import { createMigratedDatabase } from './pg-test-database';
import { describeRlsCatalog } from './rls-catalog-suite';
import { MIGRATIONS_DIR } from './test-harness';

// 系統目錄檢查，真實 PostgreSQL 版（MIL-89，驗收條件 1 到 6、13）。只在有 TEST_DATABASE_URL 時執行。
// CI 的 check 工作必須保證它真的跑到（scripts/ci/check-pg-tests-ran.mjs）。
const adminUrl = process.env.TEST_DATABASE_URL;

if (!adminUrl) {
  describe.skip('系統目錄檢查：真實 PostgreSQL', () => {});
} else {
  describeRlsCatalog('真實 PostgreSQL', async () => {
    const dbh = await createMigratedDatabase(
      adminUrl,
      (admin) => migrate(fromPgClient(admin), { dir: MIGRATIONS_DIR, runAs: 'app_owner' }),
      'cat',
    );
    return {
      q: async (sql, params) => (await dbh.admin.query(sql, params)).rows as never,
      exec: async (sql) => {
        await dbh.admin.query(sql);
      },
      close: () => dbh.close(),
    };
  });
}
