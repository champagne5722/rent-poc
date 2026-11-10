import { expect, test } from '@playwright/test';
import { signUpAsOwner } from '../helpers/login';
import { uniqueSuffix } from '../helpers/api';

// 流程 5：新屋主組織還沒有合約時，列表顯示空狀態與建立合約按鈕（MIL-174）。
// 用全新的帳號與組織，不共用其他測試的登入狀態與資料。

test.use({ storageState: { cookies: [], origins: [] } });

test('合約列表：沒有合約時顯示說明與建立合約按鈕，按下後進入建約精靈', async ({ page }) => {
  test.setTimeout(300_000);
  const suffix = uniqueSuffix();
  await signUpAsOwner(page, { email: `e2e-empty-${suffix}@example.com`, orgName: `E2E 空列表 ${suffix}` });

  await page.goto('/contracts');
  await expect(page.getByRole('heading', { name: '合約列表' })).toBeVisible();
  await expect(page.getByText(/尚無合約/)).toBeVisible();

  // 沒有資料時沒有篩選條件，也沒有「清除篩選」
  await expect(page.getByRole('button', { name: '清除篩選' })).toHaveCount(0);

  await page.getByRole('main').getByRole('button', { name: '建立合約' }).click();
  await page.waitForURL(/\/contracts\/new$/);
  await expect(page.getByRole('heading', { name: '建立合約' })).toBeVisible();
});
