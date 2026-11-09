import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// worker 數固定為 2（MIL-163）。開發機只有 16 GB，每個 worker 跑 PGlite 測試時各佔 1 到 2 GB。
// 預設值（全部核心）會讓完整測試吃到 9.7 GB。
// 覆寫方式：環境變數 VITEST_MAX_WORKERS（Vitest 4 內建支援，優先於這裡的值），或 CLI 的 --maxWorkers。
// Vitest issue #11844：無效的值會讓測試一個都不跑卻以碼 0 結束，所以這裡先檢查環境變數。
const override = process.env.VITEST_MAX_WORKERS;
if (override && !/^[1-9]\d*$/.test(override)) {
  throw new Error(`VITEST_MAX_WORKERS 必須是正整數，收到 "${override}"`);
}

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // 逾時放寬到 15 秒：每個 PGlite 測試庫要跑完全部 migration，0031 載入 17,878 列段碼（MIL-143）後，
  // 並行跑整套且連真實 PostgreSQL 時，在測試本體內建庫的檔案會超過預設的 5 秒。
  test: { include: ['src/**/*.test.ts'], testTimeout: 15_000, maxWorkers: 2, setupFiles: ['./vitest.setup.ts'] },
});
