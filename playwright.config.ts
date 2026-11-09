import { defineConfig } from '@playwright/test';

// E2E 安全網（MIL-168，ADR-0090）。不要直接跑 `playwright test`，請用 `npm run e2e` 或 `npm run e2e:visual`。
// 外殼 scripts/e2e/run-e2e.sh 會先啟動 PGlite 與 dev server，再呼叫這份設定。
//
// 兩個測試專案：
// - flows：只驗證使用者看得到的行為。UI 重構後必須通過。
// - visual：截圖比對。重構改外觀時失敗是預期的，基準只在階段驗收時更新。
// 選擇器一律用角色、文字與 label，不用 class 名稱或 DOM 結構。

const baseURL = process.env.BASE_URL ?? 'http://localhost:3410';

/** 截圖與流程共用的固定環境：桌機寬度、台北時區、繁體中文。 */
const fixedEnvironment = {
  baseURL,
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  timezoneId: 'Asia/Taipei',
  locale: 'zh-TW',
  colorScheme: 'light' as const,
  trace: 'retain-on-failure' as const,
  screenshot: 'only-on-failure' as const,
};

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e-results',
  // dev server 與 PGlite 都是單一連線，測試一個接一個跑
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: true,
  // next dev 第一次編譯每條路由要數十秒，時間限制放寬
  timeout: 120_000,
  expect: {
    timeout: 20_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.001, animations: 'disabled', caret: 'hide' },
  },
  reporter: [['list']],
  // 基準檔不帶作業系統名稱，路徑固定
  snapshotPathTemplate: '{testDir}/screenshots/{testFilePath}/{arg}{ext}',
  projects: [
    { name: 'setup', testMatch: 'setup/*.setup.ts', use: fixedEnvironment },
    {
      name: 'flows',
      testMatch: 'flows/*.e2e.ts',
      dependencies: ['setup'],
      use: { ...fixedEnvironment, storageState: 'e2e-results/.auth/state.json' },
    },
    {
      name: 'visual',
      testMatch: 'visual/*.e2e.ts',
      dependencies: ['setup'],
      use: { ...fixedEnvironment, storageState: 'e2e-results/.auth/state.json' },
    },
  ],
});
