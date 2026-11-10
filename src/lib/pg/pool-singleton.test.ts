import { afterEach, describe, expect, it, vi } from 'vitest';

// dev 模式熱重載時，Next.js 會重新執行被改到的模組，模組層級的變數跟著重置。
// 連線池掛在 globalThis（drivers.ts），所以模組重新載入後拿到的仍是同一個池，不會每次重載多開一個池（MIL-91）。
// Next 官方文件沒有連線池的專門說明，這個測試用重新載入模組來模擬熱重載。

const POOL_KEY = '__rentPocPgPool';
const globals = globalThis as unknown as Record<string, unknown>;

afterEach(async () => {
  const pool = globals[POOL_KEY] as { end(): Promise<void> } | undefined;
  delete globals[POOL_KEY];
  await pool?.end();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('連線池在模組重新載入後不重複建立', () => {
  it('重新載入 drivers 模組後，getPgPool 回傳同一個池', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://app_rw:pw@127.0.0.1:1/none');
    const first = (await import('./drivers')).getPgPool();

    vi.resetModules();
    const second = (await import('./drivers')).getPgPool();

    expect(second).toBe(first);
  });
});
