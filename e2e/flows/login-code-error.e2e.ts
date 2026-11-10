import { expect, test } from '@playwright/test';
import { uniqueSuffix } from '../helpers/api';

// 流程 6：登入頁輸入錯誤驗證碼時顯示錯誤，並清掉輸入（MIL-183）。
// 不論 email 有沒有帳號，寄出驗證碼後的畫面都相同，所以用沒註冊過的 email。

test.use({ storageState: { cookies: [], origins: [] } });

test('登入：輸入錯誤的驗證碼顯示錯誤，並能改用其他 email', async ({ page }) => {
  test.setTimeout(120_000);
  const email = `e2e-login-${uniqueSuffix()}@example.com`;

  // dev server 剛編譯完時頁面可能還沒 hydrate，整段用 toPass 重做
  await expect(async () => {
    await page.goto('/login');
    await page.getByLabel('email').fill(email);
    await page.getByRole('button', { name: '寄送驗證碼' }).click();
    await expect(page.getByText('驗證碼已寄出')).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });

  // 重寄按鈕在倒數期間停用，並顯示剩餘秒數
  await expect(page.getByRole('button', { name: /秒後可重寄/ })).toBeDisabled();

  await page.keyboard.type('000000');
  await expect(page.getByRole('alert')).toBeVisible();

  await page.getByRole('button', { name: '改用其他 email' }).click();
  await expect(page.getByRole('button', { name: '寄送驗證碼' })).toBeVisible();
});
