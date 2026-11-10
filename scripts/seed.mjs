// 對 DATABASE_URL 指向的 PostgreSQL 建立示範資料（MIL-91）。
// 先執行 npm run db:migrate。DATABASE_URL 的身分必須是 app_rw，與應用程式相同。
// 能重複執行：已存在的資料不會再建一次。成功時以 0 結束。
// 五個帳號的 email 從環境變數讀（見 src/lib/demo-seed/seed.ts 的 DEMO_SEED_EMAIL_ENV），沒設時用 example.com 的預設值。
// 用法：DATABASE_URL=postgres://app_rw:...@host/db npm run db:seed
import { registerTsHooks } from './ts-hooks.mjs';

if (!process.env.DATABASE_URL) {
  console.error('缺少環境變數 DATABASE_URL');
  process.exit(1);
}

registerTsHooks();
const { runDemoSeed, readDemoSeedEmails, DEMO_SEED_ROLES, DEMO_SEED_ROLE_LABEL } = await import('../src/lib/demo-seed/seed.ts');
const { getPgPool } = await import('../src/lib/pg/drivers.ts');

let exitCode = 0;
try {
  const emails = readDemoSeedEmails(process.env);
  const steps = await runDemoSeed(emails, { now: new Date(), env: process.env });
  for (const { step, result } of steps) console.log(`${result === 'created' ? '已建立' : '已存在'}：${step}`);
  console.log('示範帳號（登入驗證碼的取得方式見 docs/deployment.md）：');
  for (const role of DEMO_SEED_ROLES) console.log(`  ${DEMO_SEED_ROLE_LABEL[role]}：${emails[role]}`);
} catch (error) {
  console.error('種子執行失敗：', error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  await getPgPool().end();
}
process.exit(exitCode);
