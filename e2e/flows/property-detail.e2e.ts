import { expect, test } from '@playwright/test';
import { seedProperty, seedVerifiedProperty, uniqueSuffix } from '../helpers/api';

// 流程 5：物件列表與物件詳情的版型（MIL-177）。只驗證使用者看得到的行為。
// 物件列表一列一個物件，底下列租賃單位。物件詳情有返回連結、下一步與案件區。

test('已核對的物件：列表的物件列與租賃單位列有「建立案件」，詳情有下一步、建立案件入口、返回連結與案件空狀態', async ({ page, browser }) => {
  const name = `E2E 已核對物件 ${uniqueSuffix()}`;
  const property = await seedVerifiedProperty(page, browser, name);

  await page.goto('/properties');
  // 物件列、展開列的外框與租賃單位列都含物件名稱，物件列在最前面
  await expect(page.getByRole('row').filter({ hasText: name }).filter({ hasText: '已核對' }).first()).toBeVisible();
  const unitRow = page.getByRole('row', { name: new RegExp(`整戶 ${name}`) });
  await expect(unitRow.getByRole('button', { name: '建立案件' })).toBeVisible();
  const groupRow = page.getByRole('row').filter({ hasText: name }).filter({ hasText: '已核對' }).first();
  await expect(groupRow.getByRole('button', { name: '建立案件' })).toBeVisible();

  await page.goto(`/properties/${property.id}`);
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: /返回物件列表/ })).toBeVisible();
  await expect(page.getByLabel('下一步').getByText('物件已核對，可以建立案件')).toBeVisible();
  await expect(page.getByText('這個物件還沒有案件。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '建立租賃案件' })).toBeVisible();

  await page.getByRole('link', { name: /返回物件列表/ }).click();
  await expect(page).toHaveURL(/\/properties$/);
});

test('尚未核對的物件：詳情的下一步請使用者上傳謄本，列表的物件顯示待平台核對文件', async ({ page }) => {
  const name = `E2E 未核對物件 ${uniqueSuffix()}`;
  const property = await seedProperty(page, name);

  await page.goto(`/properties/${property.id}`);
  await expect(page.getByLabel('下一步').getByText('上傳謄本，請平台核對文件')).toBeVisible();
  await expect(page.getByText('已送審核')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /建立.*案件/ })).toHaveCount(0);

  await page.goto('/properties');
  const groupRow = page.getByRole('row').filter({ hasText: name }).filter({ hasText: '待平台核對文件' });
  await expect(groupRow).toBeVisible();
});

test('找不到的物件：顯示找不到與返回物件列表的連結', async ({ page }) => {
  await page.goto('/properties/not-a-valid-id');
  await expect(page.getByRole('heading', { name: '找不到物件' })).toBeVisible();
  await expect(page.getByRole('link', { name: /返回物件列表/ })).toBeVisible();
});
