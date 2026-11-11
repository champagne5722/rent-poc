import { Client, Pool } from 'pg';
import { describe, expect, it } from 'vitest';

// MIL-218 重現測試：CI 偶發 57P01。舊寫法是 pool.end() 後立刻 DROP DATABASE ... WITH (FORCE)。
// pg-pool 的 end() 不等連線的 socket 真的關閉，FORCE 終止後端時，閒置連線收到 57P01，
// Pool 沒有 error 監聽器，錯誤變成 uncaught exception。
// 只在有 TEST_DATABASE_URL 時執行（見 pg-integration.test.ts）。

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('Pool 關閉後立刻刪庫（舊寫法）', () => {
  it('重複 100 次，不應出現 uncaught exception', async () => {
    for (let i = 0; i < 100; i++) {
      const dbName = `shutdown_${Math.random().toString(36).slice(2, 10)}`;
      const root = new Client({ connectionString: adminUrl });
      await root.connect();
      await root.query(`CREATE DATABASE ${dbName}`);
      await root.end();

      const url = new URL(adminUrl!);
      url.pathname = `/${dbName}`;
      const pool = new Pool({ connectionString: url.toString(), max: 10 });
      const clients = await Promise.all(Array.from({ length: 10 }, () => pool.connect()));
      clients.forEach((c) => c.release());

      await pool.end();
      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await cleanup.end();
    }
    // 讓遲到的 57P01 有時間浮出來
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(true).toBe(true);
  }, 120_000);
});
