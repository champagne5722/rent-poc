import { expect, test } from '@playwright/test';
import { seedVerifiedProperty, uniqueSuffix } from '../helpers/api';
import { chooseOption } from '../helpers/ui';

// 流程 1：建約精靈建立草稿（MIL-168）。只驗證使用者看得到的行為。

test('建約精靈：選物件後建立草稿，進入填寫欄位，離開後草稿留在合約列表', async ({ page, browser }) => {
  const property = await seedVerifiedProperty(page, browser, `E2E 建約物件 ${uniqueSuffix()}`);

  await page.goto('/contracts/new');
  await expect(page.getByRole('heading', { name: '建立合約' })).toBeVisible();
  await expect(page.getByText('確認送簽')).toBeVisible(); // 步驟條

  // 第一步：選物件。選好後，物件資料顯示在畫面上
  await chooseOption(page.getByRole('combobox'), new RegExp(property.name));
  await expect(page.getByText(property.address, { exact: true })).toBeVisible();

  await page.getByRole('button', { name: /下一步/ }).click();

  // 草稿建立後進到第二步：填寫欄位
  await page.waitForURL(/\/contracts\/[^/]+\/edit$/);
  await expect(page.getByRole('heading', { name: /草稿 #/ })).toBeVisible();
  await expect(page.getByLabel('甲方（出租人）姓名')).toBeVisible();
  // 預設租金由物件帶入
  await expect(page.getByRole('spinbutton', { name: /月租金/ })).toHaveValue('20000');

  // 離開：草稿已保留，合約列表有這份草稿
  await page.getByRole('link', { name: /先離開/ }).click();
  await page.waitForURL(/\/contracts$/);
  const row = page.getByRole('row').filter({ hasText: property.name });
  await expect(row).toBeVisible();
  await expect(row).toContainText('草稿');
});
