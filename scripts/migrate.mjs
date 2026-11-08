// 對 DATABASE_URL 指向的 PostgreSQL 執行 db/migrations（MIL-79）。
// 第一次必須用管理者身分連線（建立角色與 schema），之後由 CI 以 app_owner 連線。
// 用法：DATABASE_URL=postgres://... npm run db:migrate
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { fromPgClient } from '../src/lib/pg/executor.ts';
import { migrate } from '../src/lib/pg/migrate.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('缺少環境變數 DATABASE_URL');
  process.exit(1);
}

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../db/migrations');
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const applied = await migrate(fromPgClient(client), { dir, runAs: 'app_owner' });
  console.log(applied.length === 0 ? '沒有待執行的 migration' : `已執行：\n${applied.join('\n')}`);
} finally {
  await client.end();
}
