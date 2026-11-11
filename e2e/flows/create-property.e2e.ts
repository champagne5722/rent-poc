import { expect, test } from '@playwright/test';
import { uniqueBuildingNo, uniqueSuffix } from '../helpers/api';
import { chooseOption, clickUntil } from '../helpers/ui';

// 流程 3：物件列表建立物件（MIL-168、MIL-196）。只驗證使用者看得到的行為。
// 登錄時建號必填。登錄後一律顯示「已登錄，待平台核對文件」，別人有沒有登錄過同一個建號，畫面都一樣。

test('物件列表：建號必填，登錄後列表出現這個物件，核對狀態是待平台核對文件', async ({ page }) => {
  const name = `E2E 物件 ${uniqueSuffix()}`;
  const address = '台北市大安區和平東路二段 100 號 3 樓';
  const buildingNo = uniqueBuildingNo();

  await page.goto('/properties');
  await expect(page.getByRole('main').getByRole('heading', { name: '物件列表' })).toBeVisible();

  await clickUntil(page.getByRole('button', { name: /新增物件/ }), page.getByRole('dialog', { name: '新增物件' }));
  const dialog = page.getByRole('dialog', { name: '新增物件' });

  await dialog.getByLabel('物件名稱').fill(name);
  await dialog.getByLabel('完整地址').fill(address);
  await dialog.getByLabel('預設租金（元/月）').fill('26000');
  // 表單沒有「暫無建號」。沒填建號時不能儲存
  await expect(dialog.getByRole('checkbox', { name: /暫無建號/ })).toHaveCount(0);
  await dialog.getByRole('button', { name: /^儲\s?存$/ }).click();
  await expect(dialog.getByText('請選縣市')).toBeVisible();
  await expect(dialog.getByText('請填建號')).toBeVisible();
  await expect(dialog).toBeVisible();

  await chooseOption(dialog.getByLabel('縣市'), '臺北市');
  await chooseOption(dialog.getByLabel('鄉鎮市區'), '大安區');
  await chooseOption(dialog.getByLabel('段小段'), /龍泉 一/);
  await dialog.getByLabel('建號', { exact: true }).fill(buildingNo);
  await dialog.getByRole('button', { name: /^儲\s?存$/ }).click();

  await expect(page.getByText('已登錄，待平台核對文件')).toBeVisible();
  await expect(dialog).toBeHidden();

  // 物件列表一列一個物件（ADR-0027 決議 5）：物件列有地址、建號與核對狀態，展開列是它底下的租賃單位
  const groupRow = page.getByRole('row').filter({ hasText: name }).filter({ hasText: '待平台核對文件' });
  await expect(groupRow).toBeVisible();
  await expect(groupRow).toContainText(address);
  await expect(groupRow).toContainText(`建號 ${buildingNo}-000`);
  await expect(groupRow).toContainText('1 個');
  // 租賃單位在物件底下，預設展開
  await expect(page.getByRole('cell', { name: '$26,000' })).toBeVisible();
  // 畫面不出現「已送審核」與審核單號
  await expect(page.getByText(/已送審核|審核單號|已在平台登錄/)).toHaveCount(0);

  // 重新整理後仍在：資料真的存進去了
  await page.reload();
  await expect(page.getByRole('row').filter({ hasText: name }).filter({ hasText: '待平台核對文件' })).toBeVisible();
});
