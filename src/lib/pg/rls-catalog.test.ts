import { createTestDb } from './test-harness';
import { describeRlsCatalog } from './rls-catalog-suite';

// 系統目錄檢查，PGlite 版（MIL-89）。每次 npm test 都跑。真實 PostgreSQL 的版本是 rls-catalog.pg.test.ts。
describeRlsCatalog('PGlite', async () => {
  const testDb = await createTestDb();
  const db = await testDb.raw();
  return {
    q: async (sql, params) => (await db.query(sql, params)).rows as never,
    exec: async (sql) => {
      await db.exec(sql);
    },
    close: async () => {
      await db.close();
      await testDb.close();
    },
  };
});
