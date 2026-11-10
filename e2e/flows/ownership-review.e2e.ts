import path from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { seedProperty, uniqueSuffix, type SeededProperty } from '../helpers/api';
import { createOwnerOrg, newUserContext, signIn } from '../baseline/session';
import { clickUntil } from '../helpers/ui';

// 流程 4：物件的出租權源文件核對（MIL-201）。
// 組織成員在物件頁同意個資告知並上傳謄本，平台營運者在審核台判定，物件頁顯示核對結果。
// 平台營運者的登入要 PLATFORM_OPERATOR_EMAILS，外殼 scripts/e2e/run-e2e.sh 替 flows 設定。
// 環境變數 MIL201_SHOTS_DIR 有值時，流程中的幾個畫面會存成截圖（給主控驗收用，平常不設）。

const OPERATOR_EMAIL = process.env.BASELINE_OPERATOR_EMAIL ?? 'e2e-operator@example.com';
const SHOTS_DIR = process.env.MIL201_SHOTS_DIR;

/** 最小的 PDF 檔頭。伺服器端以內容判斷類型，只認開頭的 %PDF。 */
const TRANSCRIPT = { name: '第二類謄本.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%E2E 測試用謄本\n') };

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS_DIR) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`), fullPage: true });
}

async function operatorPage(browser: Browser): Promise<Page> {
  const context = await newUserContext(browser);
  const page = await context.newPage();
  await signIn(page, OPERATOR_EMAIL);
  return page;
}

/** 到物件頁的「建號與核對」分頁。 */
async function openOwnershipTab(page: Page, property: SeededProperty): Promise<void> {
  await page.goto(`/properties/${property.id}`);
  await expect(page.getByRole('heading', { name: property.name })).toBeVisible();
  await clickUntil(page.getByRole('tab', { name: '建號與核對' }), page.getByText('出租權源文件', { exact: true }));
}

/** 填謄本表單並送出。表單已啟用（已同意個資告知）。 */
async function submitTranscript(page: Page, claimedOwner: string): Promise<void> {
  await page.locator('input[type="file"]').setInputFiles(TRANSCRIPT);
  await page.getByLabel('你主張的所有權人').fill(claimedOwner);
  // 日期欄位按 Enter 會直接送出表單，所以填完改用失去焦點讓日期生效
  await page.getByLabel('謄本取得時間').fill('2026-01-15');
  await page.getByLabel('謄本取得時間').blur();
  await page.getByRole('button', { name: /^(送出謄本|重新送出謄本)$/ }).click();
}

/** 營運者在審核台找到這個物件的項目並開啟核對畫面。 */
async function openReview(operator: Page, property: SeededProperty, shotName?: string): Promise<void> {
  await operator.goto('/desk');
  const row = operator.getByRole('row').filter({ hasText: new RegExp(`建號 0*${property.buildingNo}-`) });
  await expect(row).toBeVisible();
  await expect(row).toContainText('出租權源');
  if (shotName) await shot(operator, shotName);
  await row.getByRole('link', { name: '核對' }).click();
  await operator.waitForURL(/\/desk\/ownership\//);
  await expect(operator.getByRole('heading', { name: '出租權源核對' })).toBeVisible();
}

async function decide(operator: Page, options: { keyMatch: boolean; holderMatch: boolean; reason: string }): Promise<void> {
  await operator.getByRole('radio', { name: options.keyMatch ? '建號相符' : '建號不符' }).check();
  await operator.getByRole('radio', { name: options.holderMatch ? '名義人相符' : '名義人不符' }).check();
  await operator.getByLabel('謄本上的登記名義人（已遮罩）').fill('王○明');
  await operator.getByLabel('判定理由').fill(options.reason);
  await operator.getByRole('button', { name: '送出判定' }).click();
  await operator.getByRole('button', { name: /^(送\s?出|OK)$/ }).click();
  await operator.waitForURL(/\/desk$/);
}

test.describe.configure({ mode: 'serial' });

test('物件頁同意個資告知並上傳謄本，營運者判定通過後物件顯示已核對', async ({ browser }) => {
  // 個資告知的同意記在使用者身上。其他流程的資料準備（seedVerifiedProperty）已替預設的 e2e 屋主同意過，
  // 所以這個測試要看到「還沒同意」的畫面，必須用一位全新的使用者
  const owner = await newUserContext(browser);
  try {
    await runFirstConsentFlow(await owner.newPage(), browser);
  } finally {
    await owner.close();
  }
});

async function runFirstConsentFlow(page: Page, browser: Browser): Promise<void> {
  const suffix = uniqueSuffix();
  await signIn(page, `e2e-consent-${suffix}@example.com`);
  await createOwnerOrg(page, `E2E 核對屋主 ${suffix}`);
  const property = await seedProperty(page, `E2E 核對物件 ${suffix}`);
  await openOwnershipTab(page, property);

  // 還沒同意個資告知：顯示告知，上傳表單停用
  await expect(page.getByText('請上傳第二類謄本，平台會核對所有權')).toBeVisible();
  await expect(page.getByRole('button', { name: '同意並繼續' })).toBeVisible();
  await expect(page.getByRole('button', { name: '送出謄本' })).toBeDisabled();
  await expect(page.getByLabel('你主張的所有權人')).toBeDisabled();
  // 檔案限制寫在表單上
  await expect(page.getByText(/PDF、PNG 或 JPG.*10 MB/)).toBeVisible();
  await shot(page, '1-物件頁-個資告知');

  // 同意後表單啟用
  await clickUntil(page.getByRole('button', { name: '同意並繼續' }), page.getByText(/你已同意「/));
  await expect(page.getByLabel('你主張的所有權人')).toBeEnabled();
  await expect(page.getByRole('button', { name: '送出謄本' })).toBeEnabled();

  // 欄位沒填就送出：顯示欄位錯誤，不送件
  await page.getByRole('button', { name: '送出謄本' }).click();
  await expect(page.getByText('請選擇謄本檔案')).toBeVisible();
  await expect(page.getByText('請填你主張的所有權人')).toBeVisible();
  await shot(page, '2-物件頁-上傳表單');

  // 謄本顯示信託登記：出現四項必填資料
  await page.getByRole('checkbox', { name: '謄本顯示信託登記' }).check();
  for (const label of ['登記所有權人', '信託關係人', '信託登記狀態', '出租權限條款']) {
    await expect(page.getByLabel(label)).toBeVisible();
  }
  await page.getByRole('checkbox', { name: '謄本顯示信託登記' }).uncheck();

  await submitTranscript(page, '王大明');
  await expect(page.getByText('文件已送出，等待平台核對').first()).toBeVisible();
  await expect(page.getByText('待平台核對文件').first()).toBeVisible();
  await expect(page.getByText('第二類謄本.pdf')).toBeVisible();
  // 送出後不再顯示上傳表單，也沒有開啟原檔的連結
  await expect(page.getByRole('button', { name: '送出謄本' })).toBeHidden();
  await expect(page.getByRole('link', { name: /第二類謄本/ })).toHaveCount(0);
  await shot(page, '3-物件頁-待核對');

  // 營運者在審核台判定
  const operator = await operatorPage(browser);
  try {
    await openReview(operator, property, '4-審核台-佇列');
    await expect(operator.getByText('王大明')).toBeVisible();
    await expect(operator.getByRole('link', { name: /開啟 第二類謄本\.pdf/ })).toBeVisible();
    await shot(operator, '5-審核台-詳情');

    // 理由必填：沒填就送出會被擋下
    await operator.getByRole('radio', { name: '建號相符' }).check();
    await operator.getByRole('radio', { name: '名義人相符' }).check();
    await operator.getByLabel('謄本上的登記名義人（已遮罩）').fill('王○明');
    await expect(operator.getByText('送出後，物件對外狀態是')).toBeVisible();
    await shot(operator, '6-審核台-判定');
    await operator.getByRole('button', { name: '送出判定' }).click();
    await operator.getByRole('button', { name: /^(送\s?出|OK)$/ }).click();
    await expect(operator.getByText('請填判定理由')).toBeVisible();

    await operator.getByLabel('判定理由').fill('建號與名義人都和謄本相符');
    await operator.getByRole('button', { name: '送出判定' }).click();
    await operator.getByRole('button', { name: /^(送\s?出|OK)$/ }).click();
    await operator.waitForURL(/\/desk$/);
  } finally {
    await operator.context().close();
  }

  // 物件頁：已核對，說明文字固定
  await openOwnershipTab(page, property);
  await expect(page.getByText('已核對').first()).toBeVisible();
  await expect(page.getByText('平台已比對出租權源文件')).toBeVisible();
  await expect(page.getByRole('button', { name: /送出謄本/ })).toBeHidden();
  await shot(page, '8-物件頁-已核對');
}

test('營運者判定不符後，物件頁顯示固定訊息，使用者修正並重新送出', async ({ page, browser }) => {
  const property = await seedProperty(page, `E2E 不符物件 ${uniqueSuffix()}`);
  await openOwnershipTab(page, property);
  // 個資告知的同意記在使用者身上。同一位使用者在前一個測試已同意時，這裡直接看到「你已同意」
  const agreed = page.getByText(/你已同意「/);
  await expect(agreed.or(page.getByRole('button', { name: '同意並繼續' }))).toBeVisible();
  if (!(await agreed.isVisible())) await clickUntil(page.getByRole('button', { name: '同意並繼續' }), agreed);
  await submitTranscript(page, '李小華');
  await expect(page.getByText('文件已送出，等待平台核對').first()).toBeVisible();

  const operator = await operatorPage(browser);
  try {
    await openReview(operator, property);
    await decide(operator, { keyMatch: true, holderMatch: false, reason: '謄本的登記名義人是另一位' });
    // 結案後的項目在已結案清單，詳情顯示判定結果
    await operator.getByText(/^已結案/).first().click();
    const closedRow = operator.getByRole('row').filter({ hasText: new RegExp(`建號 0*${property.buildingNo}-`) });
    await expect(closedRow).toBeVisible();
    await closedRow.getByRole('link', { name: '查看' }).click();
    await operator.waitForURL(/\/desk\/ownership\//);
    await expect(operator.getByText('判定結果')).toBeVisible();
    await expect(operator.getByRole('button', { name: '送出判定' })).toBeHidden();
    await shot(operator, '7-審核台-已結案');
  } finally {
    await operator.context().close();
  }

  // 物件頁：文件不符，只有固定訊息，不提到任何別人
  await openOwnershipTab(page, property);
  await expect(page.getByText('文件核對未通過')).toBeVisible();
  await expect(page.getByText(/登記名義人與你主張的所有權人不符/)).toBeVisible();
  await expect(page.getByText('文件不符').first()).toBeVisible();
  await expect(page.getByText(/別的組織|別人|另一個組織|其他組織/)).toHaveCount(0);
  await shot(page, '9-物件頁-不符');

  // 已同意過個資告知：直接重新送出
  await expect(page.getByRole('button', { name: '同意並繼續' })).toBeHidden();
  await submitTranscript(page, '李小華');
  await expect(page.getByText('文件已送出，等待平台核對').first()).toBeVisible();
  await expect(page.getByText('待平台核對文件').first()).toBeVisible();
  await expect(page.getByText('文件核對未通過')).toBeHidden();
});
