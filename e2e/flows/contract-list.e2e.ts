import { expect, test } from '@playwright/test';
import { seedDraft, seedSendableDraft, seedVerifiedProperty, uniqueSuffix } from '../helpers/api';
import { chooseOption } from '../helpers/ui';

// 流程 4：合約列表的篩選與清除篩選（MIL-174）。只驗證使用者看得到的行為。
// 列表資料在 server component 載入，篩選在畫面上即時生效，不重新整理頁面。

test('合約列表：依狀態篩選，篩選後沒有結果時顯示清除篩選，清除後回到全部', async ({ page, browser }) => {
  const property = await seedVerifiedProperty(page, browser, `E2E 列表物件 ${uniqueSuffix()}`);
  const sentId = await seedSendableDraft(page, property.id);
  expect((await page.request.post(`/api/contracts/${sentId}/send`)).ok()).toBe(true);
  await seedDraft(page, property.id);

  await page.goto('/contracts');
  await expect(page.getByRole('heading', { name: '合約列表' })).toBeVisible();
  const rows = page.getByRole('row').filter({ hasText: property.name });
  await expect(rows).toHaveCount(2);

  // 依狀態篩選：只留下草稿
  await page.getByText(/^草稿 \d+$/).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('草稿');

  // 狀態加上物件篩選，選一個這個物件沒有的狀態：沒有結果，空狀態與篩選列都有「清除篩選」
  await chooseOption(page.getByRole('combobox').first(), new RegExp(property.name));
  await page.getByText(/^已完成 \d+$/).click();
  await expect(page.getByText('沒有符合篩選條件的資料')).toBeVisible();
  await expect(rows).toHaveCount(0);
  await expect(page.getByRole('button', { name: '清除篩選' })).toHaveCount(2);

  // 按下空狀態的清除篩選：全部條件解除，兩份合約回來
  await page.getByRole('main').getByRole('button', { name: '清除篩選' }).last().click();
  await expect(page.getByText('沒有符合篩選條件的資料')).toBeHidden();
  await expect(rows).toHaveCount(2);
  await expect(page.getByRole('button', { name: '清除篩選' })).toHaveCount(0);
});
