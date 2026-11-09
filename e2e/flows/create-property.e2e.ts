import { expect, test } from '@playwright/test';
import { uniqueSuffix } from '../helpers/api';
import { clickUntil } from '../helpers/ui';

// 流程 3：物件列表建立物件（MIL-168）。只驗證使用者看得到的行為。

test('物件列表：新增物件後，列表出現這個物件', async ({ page }) => {
  const name = `E2E 物件 ${uniqueSuffix()}`;
  const address = '台北市大安區和平東路二段 100 號 3 樓';

  await page.goto('/properties');
  await expect(page.getByRole('main').getByRole('heading', { name: '物件' })).toBeVisible();

  await clickUntil(page.getByRole('button', { name: /新增物件/ }), page.getByRole('dialog', { name: '新增物件' }));
  const dialog = page.getByRole('dialog', { name: '新增物件' });

  await dialog.getByLabel('物件名稱').fill(name);
  await dialog.getByLabel('完整地址').fill(address);
  await dialog.getByLabel('預設租金（元/月）').fill('26000');
  // 沒有建號時先用門牌登錄，產權狀態是「待驗證」
  await dialog.getByRole('checkbox', { name: /暫無建號/ }).check();
  await dialog.getByRole('button', { name: /^儲\s?存$/ }).click();

  await expect(page.getByText('物件已建立')).toBeVisible();
  await expect(dialog).toBeHidden();

  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(row).toContainText(address);
  await expect(row).toContainText('$26,000');
  await expect(row).toContainText('待驗證');

  // 重新整理後仍在：資料真的存進去了
  await page.reload();
  await expect(page.getByRole('row').filter({ hasText: name })).toBeVisible();
});
