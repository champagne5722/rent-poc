import { Pool } from 'pg';
import { afterAll, beforeAll, describe } from 'vitest';
import { pgDriver } from './drivers';
import { fromPgClient } from './executor';
import { migrate } from './migrate';
import { createMigratedDatabase, type MigratedDatabase } from './pg-test-database';
import {
  describeForeignKeyPenetration,
  describeOrgTablePenetration,
  describeRegistryFunctionPenetration,
  type PenetrationEnv,
} from './rls-penetration-suite';
import { MIGRATIONS_DIR } from './test-harness';
import { createWithTx } from './with-tx';

// 跨組織滲透探測，真實 PostgreSQL 版（MIL-89，驗收條件 7、9）。
// 與 rls-penetration.test.ts 共用 rls-penetration-suite.ts 的探測，所以兩個引擎驗的是同一組行為。
// 連線池只開 1 條：每個交易必然重用同一條連線，脈絡外洩時最容易現形。
// 只在有 TEST_DATABASE_URL 時執行。CI 的 check 工作必須保證它真的跑到（scripts/ci/check-pg-tests-ran.mjs）。
const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('跨組織滲透探測：真實 PostgreSQL', () => {
  let dbh: MigratedDatabase;
  let pool: Pool;
  const env: PenetrationEnv = {
    async prepare(orgA, orgB) {
      await dbh.admin.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'A', 'owner'), ($2, 'B', 'owner')`, [orgA, orgB]);
      return createWithTx(pgDriver(pool));
    },
  };

  beforeAll(async () => {
    dbh = await createMigratedDatabase(
      adminUrl!,
      (admin) => migrate(fromPgClient(admin), { dir: MIGRATIONS_DIR, runAs: 'app_owner' }),
      'pen',
    );
    pool = new Pool({ connectionString: dbh.appRwUrl, max: 1 });
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
    await dbh?.close();
  });

  describeOrgTablePenetration(env);
  describeRegistryFunctionPenetration(env);
  describeForeignKeyPenetration(env);
});
