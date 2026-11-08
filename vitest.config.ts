import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // 逾時放寬到 15 秒：每個 PGlite 測試庫要跑完全部 migration，0031 載入 17,878 列段碼（MIL-143）後，
  // 並行跑整套且連真實 PostgreSQL 時，在測試本體內建庫的檔案會超過預設的 5 秒。
  test: { include: ['src/**/*.test.ts'], testTimeout: 15_000 },
});
