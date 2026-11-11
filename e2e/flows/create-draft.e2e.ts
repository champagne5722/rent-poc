import { expect, test } from '@playwright/test';
import { seedDraft, seedProperty, seedVerifiedProperty, uniqueSuffix } from '../helpers/api';
import { clickUntil } from '../helpers/ui';
import { collectConsoleProblems } from '../helpers/console';

// 流程 1：從物件建立案件並進建約精靈建立草稿（MIL-168、MIL-209、MIL-205）。只驗證使用者看得到的行為。
// 建立案件的入口在物件上，精靈不再選物件，物件與案件種類由入口參數帶入。

test('從物件詳情的入口進建約精靈：物件唯讀顯示，建立草稿後進入填寫欄位，離開後草稿留在合約列表', async ({ page, browser }) => {
  const property = await seedVerifiedProperty(page, browser, `E2E 建約物件 ${uniqueSuffix()}`);

  // 入口：屋主組織對已核對的物件只能建租賃案件，所以是一顆直接進精靈的按鈕
  await page.goto(`/properties/${property.id}`);
  await expect(page.getByRole('heading', { name: property.name, level: 1 })).toBeVisible();
  await clickUntil(page.getByRole('button', { name: '建立租賃案件' }), page.getByRole('heading', { name: '建立合約' }));
  await expect(page).toHaveURL(new RegExp(`/contracts/new\\?property=${property.id}&kind=lease$`));
  await expect(page.getByText('確認送簽')).toBeVisible(); // 步驟條

  // 第一步：沒有選物件的控制項。物件資料唯讀顯示，案件種類由入口決定
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await expect(page.getByText(property.name, { exact: true })).toBeVisible();
  await expect(page.getByText(property.address, { exact: true })).toBeVisible();
  await expect(page.getByText('租賃案件', { exact: true }).first()).toBeVisible();
  // 業務類型與「承租人是否為包租業者」由案件種類決定，只顯示不給選
  await expect(page.getByRole('radio', { name: '自管' })).toBeDisabled();
  await expect(page.getByRole('radio', { name: '否' }).first()).toBeDisabled();

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

test('從物件列表的入口建立案件：每一列打開入口才查，選了種類就進建約精靈', async ({ page, browser }) => {
  const name = `E2E 列表入口物件 ${uniqueSuffix()}`;
  const property = await seedVerifiedProperty(page, browser, name);

  await page.goto('/properties');
  const unitRow = page.getByRole('row', { name: new RegExp(`整戶 ${name}`) });
  await clickUntil(unitRow.getByRole('button', { name: '建立案件' }), page.getByRole('menuitem', { name: '建立租賃案件' }));
  await page.getByRole('menuitem', { name: '建立租賃案件' }).click();
  await page.waitForURL(new RegExp(`/contracts/new\\?property=${property.id}&kind=lease$`));
  await expect(page.getByRole('heading', { name: '建立合約' })).toBeVisible();
  await expect(page.getByText(property.address, { exact: true })).toBeVisible();
});

test('未通過核對的物件：列表與詳情都沒有建立案件的入口，詳情的下一步說明原因', async ({ page }) => {
  const name = `E2E 未核對入口物件 ${uniqueSuffix()}`;
  const property = await seedProperty(page, name);

  await page.goto('/properties');
  const groupRow = page.getByRole('row').filter({ hasText: name }).filter({ hasText: '待平台核對文件' });
  await expect(groupRow).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: name }).getByRole('button', { name: /建立/ })).toHaveCount(0);
  await expect(groupRow.getByText('尚未核對，不能建立案件')).toBeVisible();

  await page.goto(`/properties/${property.id}`);
  await expect(page.getByLabel('下一步').getByText('物件尚未通過平台的文件核對，通過後才能建立案件。')).toBeVisible();
  await expect(page.getByRole('button', { name: /建立.*案件/ })).toHaveCount(0);
});

test('建約精靈：直接開網址時，伺服端擋下未核對的物件，顯示原因與下一步', async ({ page }) => {
  const property = await seedProperty(page, `E2E 直接開網址物件 ${uniqueSuffix()}`);

  await page.goto(`/contracts/new?property=${property.id}&kind=lease`);
  await expect(page.getByRole('heading', { name: '建立合約' })).toBeVisible();
  await clickUntil(page.getByRole('button', { name: /下一步/ }), page.getByText('物件尚未通過平台的文件核對'));
  // 顯示原因與下一步的連結，不顯示錯誤碼
  await expect(page.getByText('property_not_verified')).toHaveCount(0);
  await page.getByRole('link', { name: '查看物件的核對狀態' }).click();
  await expect(page).toHaveURL(new RegExp(`/properties/${property.id}$`));
});

test('委託管理合約的暫時入口：物件列表的次要動作進精靈，建立草稿後進入續編', async ({ page }) => {
  await page.goto('/properties');
  await clickUntil(page.getByRole('button', { name: '建立委託管理合約' }), page.getByText('委託管理合約不綁單一物件'));
  await expect(page).toHaveURL(/\/contracts\/new\?kind=management$/);
  await page.getByRole('button', { name: /下一步/ }).click();
  await page.waitForURL(/\/contracts\/[^/]+\/edit$/);
  await expect(page.getByRole('heading', { name: /草稿 #/ })).toBeVisible();
});

test('建約精靈：沒帶參數、參數不合法、物件看不到時，導到物件列表', async ({ page }) => {
  for (const url of [
    '/contracts/new',
    '/contracts/new?property=not-a-ulid&kind=lease',
    '/contracts/new?kind=unknown',
    '/contracts/new?property=01JD3X7Z5K8M2N4P6Q8R0S2T4V&kind=management',
    // 格式正確但不存在，與別的組織的物件相同：導到物件列表
    '/contracts/new?property=01JD3X7Z5K8M2N4P6Q8R0S2T4V&kind=lease',
  ]) {
    await page.goto(url);
    await page.waitForURL(/\/properties$/);
    await expect(page.getByRole('heading', { name: '物件列表' })).toBeVisible();
  }
});

test('建約精靈第一步：載入後沒有 console error，也沒有頁面錯誤（MIL-209）', async ({ page, browser }) => {
  const property = await seedVerifiedProperty(page, browser, `E2E 精靈主控台物件 ${uniqueSuffix()}`);
  const problems = collectConsoleProblems(page);

  await page.goto(`/contracts/new?property=${property.id}&kind=lease`);
  await expect(page.getByRole('heading', { name: '建立合約' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  // 先印出來，出現新的訊息時看得到原文
  console.log(`精靈第一步的 console 訊息：${JSON.stringify(problems, null, 2)}`);
  expect(problems).toEqual([]);
});

test('建約精靈第二步：填寫欄位載入後沒有 console error，也沒有頁面錯誤（MIL-176）', async ({ page, browser }) => {
  const property = await seedVerifiedProperty(page, browser, `E2E 精靈第二步主控台物件 ${uniqueSuffix()}`);
  const draftId = await seedDraft(page, property.id);
  const problems = collectConsoleProblems(page);

  await page.goto(`/contracts/${draftId}/edit`);
  await expect(page.getByLabel('甲方（出租人）姓名')).toBeVisible();
  await page.waitForLoadState('networkidle');
  // 先印出來，出現新的訊息時看得到原文
  console.log(`精靈第二步的 console 訊息：${JSON.stringify(problems, null, 2)}`);
  expect(problems).toEqual([]);
});
