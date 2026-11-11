import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTestPool, createTestPool, dropTestDatabase, testPoolErrors } from './pg-database-kit';

// MIL-218：CI 的 check 偶發 57P01（連線被管理者指令終止），測試全過後才丟出 uncaught exception。
//
// 舊寫法（已被 pg-test-teardown.guard.test.ts 禁止）：
//   await pool.end();
//   await root.query(`<刪除資料庫的 SQL，帶 WITH (FORCE)>`);
// pg-pool 的 end() 不等連線的 socket 真的關閉。FORCE 終止後端時，閒置連線收到 57P01，
// Pool 沒有 error 監聽器，錯誤變成 uncaught exception。用舊寫法重複 100 次，
// CI 的 check 會以 Unhandled Error 失敗（修正前的 run 43019540748，4 個 57P01）。
//
// 新寫法：createTestPool 掛上 error 監聽器，closeTestPool 等全部連線真的關閉，之後才刪庫。
// 只在有 TEST_DATABASE_URL 時執行（見 pg-integration.test.ts）。

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('Pool 關閉後立刻刪庫', () => {
  const uncaught: Error[] = [];
  const onUncaught = (err: Error) => {
    uncaught.push(err);
  };
  beforeEach(() => {
    process.on('uncaughtException', onUncaught);
  });
  afterEach(() => {
    process.off('uncaughtException', onUncaught);
  });

  it('用共用輔助函式重複 100 次，沒有 uncaught exception，Pool 也沒有收到錯誤', async () => {
    const poolErrors: Error[] = [];
    for (let i = 0; i < 100; i++) {
      const dbName = `shutdown_${Math.random().toString(36).slice(2, 10)}`;
      const root = new Client({ connectionString: adminUrl });
      await root.connect();
      await root.query(`CREATE DATABASE ${dbName}`);
      await root.end();

      const url = new URL(adminUrl!);
      url.pathname = `/${dbName}`;
      const pool = createTestPool({ connectionString: url.toString(), max: 10 });
      const clients = await Promise.all(Array.from({ length: 10 }, () => pool.connect()));
      clients.forEach((c) => c.release());

      await closeTestPool(pool);
      await dropTestDatabase(adminUrl!, dbName);
      poolErrors.push(...testPoolErrors(pool));
    }
    // 讓遲到的錯誤有時間浮出來
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(uncaught.map((e) => e.message)).toEqual([]);
    expect(poolErrors.map((e) => e.message)).toEqual([]);
  }, 120_000);
});
