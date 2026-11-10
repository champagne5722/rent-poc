import { afterAll, beforeAll, describe } from 'vitest';
import { pgDriver } from './drivers';
import { createPgTestDatabase, type PgTestDatabase } from './pg-database-kit';
import {
  describeForeignKeyPenetration,
  describeOrgTablePenetration,
  describeRegistryFunctionPenetration,
  type PenetrationEnv,
} from './rls-penetration-suite';
import { createWithTx } from './with-tx';

// 跨組織滲透探測，真實 PostgreSQL 版（MIL-89，驗收條件 7、8、9）。
// 與 rls-penetration.test.ts 共用 rls-penetration-suite.ts 的探測，所以兩個引擎驗的是同一組行為。
// 連線池只開 1 條：每個交易必然重用同一條連線，脈絡外洩時最容易現形。
// 只在有 TEST_DATABASE_URL 時執行。CI 的 check 工作必須保證它真的跑到（scripts/ci/check-pg-tests-ran.mjs）。
const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('跨組織滲透探測：真實 PostgreSQL', () => {
  let dbh: PgTestDatabase;
  const env: PenetrationEnv = {
    async prepare(orgA, orgB) {
      await dbh.owner.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'A', 'owner'), ($2, 'B', 'owner')`, [orgA, orgB]);
      return createWithTx(pgDriver(dbh.pool));
    },
  };

  beforeAll(async () => {
    dbh = await createPgTestDatabase(adminUrl!, 1);
  }, 120_000);
  afterAll(async () => {
    await dbh?.close();
  });

  describeOrgTablePenetration(env);
  describeRegistryFunctionPenetration(env);
  describeForeignKeyPenetration(env);
});
