import { expect, test } from '@playwright/test';
import { seedOwnerHandover, uniqueSuffix } from '../helpers/api';
import { signUpAsOwner } from '../helpers/login';
import { collectConsoleProblems } from '../helpers/console';

// 流程 8：屋主端移交詳情（MIL-185）。
// 移交資料還在記憶體 adapter，真實登入的屋主預設看不到移交，所以先走 demo API 替這位屋主建立一筆。
// 用全新的帳號與組織，不改共用登入狀態。

test.use({ storageState: { cookies: [], origins: [] } });

test('屋主端移交：清單列出示範移交，詳情頁載入後沒有 console error', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const suffix = uniqueSuffix();
  await signUpAsOwner(page, { email: `e2e-handover-${suffix}@example.com`, orgName: `E2E 移交 ${suffix}` });
  const id = await seedOwnerHandover(page, 'draft');

  const problems = collectConsoleProblems(page);

  await page.goto('/owner/handovers');
  await expect(page.getByText('臺北市中山區民生東路三段 51 號 9 樓')).toBeVisible();
  await page.getByRole('link', { name: '檢查草稿' }).click();
  await page.waitForURL(new RegExp(`/owner/handovers/${id}$`));
  await expect(page.getByRole('heading', { name: /民生東路三段 51 號 9 樓/ })).toBeVisible();
  await expect(page.getByText('移交包內容').first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: testInfo.outputPath('after-owner-handover-detail.png'), fullPage: true });
  console.log(`移交詳情的 console 訊息：${JSON.stringify(problems, null, 2)}`);
  expect(problems).toEqual([]);
});
