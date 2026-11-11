import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { seedProperty, seedVerifiedProperty } from '../helpers/api';
import { seedPracticeAndDesk } from './seed';
import { createPracticeOrg, newUserContext, signIn } from './session';

// 從物件建立案件的入口截圖（MIL-209、MIL-205 畫面段），給主控看。沒有斷言，只截圖。
// 執行方式（在 worktree 根目錄）：
//   MIL209_SHOTS=<輸出資料夾> HEAVY_COST=6 scripts/heavy.sh e2e-209 scripts/e2e/run-e2e.sh baseline --grep "MIL-209"
// 產出：物件列表打開入口、物件詳情的入口（屋主組織與業者組織各一張）、未核對物件的詳情、從入口進來的精靈第一步。

const OUT = process.env.MIL209_SHOTS ?? path.join(os.tmpdir(), 'mil-209-shots');
const OWNER_STATE = 'e2e-results/.auth/state.json';
const OPERATOR_EMAIL = process.env.BASELINE_OPERATOR_EMAIL ?? 'e2e-operator@example.com';

async function shoot(page: Page, file: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.screenshot({ path: path.join(OUT, file), fullPage: true, animations: 'disabled', caret: 'hide' });
}

test('MIL-209 入口截圖：屋主組織', async ({ browser }) => {
  test.setTimeout(600_000);
  mkdirSync(OUT, { recursive: true });
  const context = await newUserContext(browser, { storageState: OWNER_STATE });
  const page = await context.newPage();
  await page.goto('/');
  const verified = await seedVerifiedProperty(page, browser, '入口示範物件（已核對）', '台北市大安區和平東路二段 100 號 3 樓');
  const unverified = await seedProperty(page, '入口示範物件（未核對）', '新北市板橋區文化路一段 200 號 5 樓');

  // 物件列表：打開租賃單位列的入口
  await page.goto('/properties');
  const unitRow = page.getByRole('row', { name: /整戶 入口示範物件（已核對）/ });
  await expect(async () => {
    await unitRow.getByRole('button', { name: '建立案件' }).click({ timeout: 5_000 });
    await expect(page.getByRole('menuitem', { name: '建立租賃案件' })).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  await shoot(page, '1-物件列表-打開入口.png');

  // 物件詳情：已核對（屋主組織只能建租賃案件）
  await page.goto(`/properties/${verified.id}`);
  await expect(page.getByRole('button', { name: '建立租賃案件' })).toBeVisible();
  await shoot(page, '2-物件詳情-屋主組織.png');

  // 物件詳情：未核對，沒有入口，下一步說明原因
  await page.goto(`/properties/${unverified.id}`);
  await expect(page.getByLabel('下一步').getByText('物件尚未通過平台的文件核對，通過後才能建立案件。')).toBeVisible();
  await shoot(page, '3-物件詳情-未核對.png');

  // 從入口進來的精靈第一步
  await page.goto(`/properties/${verified.id}`);
  await expect(async () => {
    await page.getByRole('button', { name: '建立租賃案件' }).click({ timeout: 5_000 });
    await expect(page.getByRole('heading', { name: '建立合約' })).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByText('入口示範物件（已核對）', { exact: true })).toBeVisible();
  await shoot(page, '4-精靈第一步.png');

  // 精靈被伺服端擋下的畫面：直接開未核對物件的網址
  await page.goto(`/contracts/new?property=${unverified.id}&kind=lease`);
  await expect(async () => {
    await page.getByRole('button', { name: /下一步/ }).click({ timeout: 5_000 });
    await expect(page.getByText('物件尚未通過平台的文件核對')).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  await shoot(page, '5-精靈-伺服端擋下未核對.png');
});

test('MIL-209 入口截圖：業者組織', async ({ browser }) => {
  test.setTimeout(900_000);
  mkdirSync(OUT, { recursive: true });
  const operator = await (await newUserContext(browser)).newPage();
  const practice = await (await newUserContext(browser)).newPage();
  const practice2 = await (await newUserContext(browser)).newPage();
  const practice3 = await (await newUserContext(browser)).newPage();
  await signIn(operator, OPERATOR_EMAIL);
  await signIn(practice, 'e2e-practice@example.com');
  await createPracticeOrg(practice, { name: '北辰示範租賃股份有限公司', taxId: '24680135', entityType: 'company', kinds: ['management', 'master_lease'] });
  await signIn(practice2, 'e2e-practice2@example.com');
  await createPracticeOrg(practice2, { name: '雲頂示範經紀行', taxId: '13572468', entityType: 'firm', kinds: ['brokerage'] });
  await signIn(practice3, 'e2e-practice3@example.com');
  await createPracticeOrg(practice3, { name: '星河示範經紀行', taxId: '11223344', entityType: 'firm', kinds: ['brokerage'] });
  await seedPracticeAndDesk(practice, practice2, practice3, operator);

  const property = await seedVerifiedProperty(practice, browser, '業者入口示範物件', '台北市中山區南京東路二段 50 號 6 樓');
  await practice.goto('/properties');
  const unitRow = practice.getByRole('row', { name: /整戶 業者入口示範物件/ });
  await expect(async () => {
    await unitRow.getByRole('button', { name: '建立案件' }).click({ timeout: 5_000 });
    await expect(practice.getByRole('menuitem').first()).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  await shoot(practice, '6-物件列表-業者組織打開入口.png');

  await practice.goto(`/properties/${property.id}`);
  await expect(practice.getByLabel('下一步')).toBeVisible();
  await shoot(practice, '7-物件詳情-業者組織.png');
});
