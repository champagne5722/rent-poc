import { expect, test } from '@playwright/test';
import { seedPracticeWithLicense, uniqueSuffix } from '../helpers/api';

// 流程 7：執業主體頁（/practice）載入後沒有 console error，也沒有頁面錯誤（MIL-185）。
// 起因是 impeccable audit 在這一頁抓到 hydration 錯誤。業別表有一列送件時間，是 server 與瀏覽器各算一次的文字。
// 用全新的帳號與組織，不改共用登入狀態。

test.use({ storageState: { cookies: [], origins: [] } });

test('執業主體頁：載入後沒有 console error，也沒有頁面錯誤', async ({ page }) => {
  test.setTimeout(300_000);
  const suffix = uniqueSuffix();
  await seedPracticeWithLicense(page, { email: `e2e-practice-${suffix}@example.com`, name: `E2E 執業主體 ${suffix}` });

  const problems: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') problems.push(`console.${msg.type()}: ${msg.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));

  await page.goto('/practice');
  await expect(page.getByRole('heading', { name: '執業主體登錄' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '北市租管字第 9999 號' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  // 先印出來，出現新的訊息時看得到原文
  console.log(`執業主體頁的 console 訊息：${JSON.stringify(problems, null, 2)}`);
  expect(problems).toEqual([]);
});
