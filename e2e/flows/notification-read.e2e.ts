import { expect, test } from '@playwright/test';
import { seedNotification, uniqueSuffix } from '../helpers/api';
import { signUpAsOwner } from '../helpers/login';

// 流程 6：站內通知的未讀列與標已讀（MIL-179、MIL-185）。
// 用全新的帳號與組織，通知清單只有這一筆，不改共用登入狀態的未讀數。

test.use({ storageState: { cookies: [], origins: [] } });

test('通知列表：未讀列有「未讀」字樣，點「標為已讀」後變已讀', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const suffix = uniqueSuffix();
  await signUpAsOwner(page, { email: `e2e-notify-${suffix}@example.com`, orgName: `E2E 通知 ${suffix}` });
  const title = `E2E 測試通知 ${suffix}`;
  await seedNotification(page, title);

  // 未讀列有時間文字，server 與瀏覽器各算一次，不一致會造成 hydration 錯誤（MIL-185）
  const problems: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') problems.push(`console.${msg.type()}: ${msg.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));

  await page.goto('/notifications');
  const row = page.getByRole('row').filter({ hasText: title });
  await expect(row).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(problems).toEqual([]);
  await expect(row.getByText('未讀', { exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: '標為已讀' })).toBeVisible();
  await expect(page.getByRole('button', { name: '全部標為已讀' })).toBeEnabled();
  // 截圖寫到測試的輸出目錄，不寫進 docs/（MIL-176）
  await page.screenshot({ path: testInfo.outputPath('after-notifications-unread.png') });

  await row.getByRole('button', { name: '標為已讀' }).click();
  await expect(row.getByText('已讀', { exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: '標為已讀' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '全部標為已讀' })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('after-notifications-read.png') });
});
