import { asRole, createTestDb } from './test-harness';
import { pgliteDriver } from './drivers';
import { describeWithTxContract } from './with-tx-contract';

// PGlite 驅動跑契約測試。連線身分由 harness 的 fresh() 保證是 app_rw。
describeWithTxContract('PGlite', async () => {
  const testDb = await createTestDb();
  const db = await testDb.fresh();
  return {
    driver: pgliteDriver(db),
    asOwner: (sql) => asRole(db, 'app_owner', () => db.exec(sql)).then(() => undefined),
    close: async () => {
      await db.close();
      await testDb.close();
    },
  };
});
