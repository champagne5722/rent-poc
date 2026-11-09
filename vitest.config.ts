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
  test: { include: ['src/**/*.test.ts'], maxWorkers: 2 },
});
