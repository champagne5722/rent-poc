import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { seedDraft, seedProperty, seedSendableDraft } from '../helpers/api';
import { chooseOption } from '../helpers/ui';

// 截圖基準（MIL-168）：合約列表、合約詳情、建約精靈、物件列表。
// UI 重構改外觀時，這裡的比對失敗是預期的。基準只在階段驗收時由主控更新：npm run e2e:visual -- --update-snapshots
//
// 讓比對能重現：
// - 視窗 1440x900、台北時區、繁體中文，見 playwright.config.ts。
// - 瀏覽器端的時間固定在 FIXED_NOW。伺服器端產生的時間戳與 ID 每次不同，截圖前換成固定樣本。
// - 截圖前等字型載入完成，動畫關閉（設定檔）。
// - 資料庫每次執行都是全新的，資料名稱與內容固定，所以列表的筆數與順序固定。

const FIXED_NOW = new Date('2026-11-10T10:00:00+08:00');

const seeded = {
  propertyA: '',
  propertyB: '',
  sentContractId: '',
  readyDraftId: '',
  bareDraftId: '',
};

// 後面的測試共用這裡備好的資料
test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
});

/**
 * 每次執行都不同的內容：合約 ID（末碼、標題裡的 #XXXXXX）與伺服器端的時間戳。
 * 不用遮罩：ID 的字寬不同，標題旁邊的標籤位置會跟著位移，遮住文字擋不住位移。
 * 改成截圖前把這些文字換成固定的樣本，版面就一致。只改畫面上的文字，不動應用程式碼。
 */
async function normalizeVolatileText(page: Page): Promise<void> {
  await page.evaluate(() => {
    const replacements: Array<[RegExp, string]> = [
      [/#[0-9A-Z]{6}/g, '#ABCDEF'],
      [/^[0-9A-Z]{6}$/, 'ABCDEF'],
      [/^\d{2}-\d{2} \d{2}:\d{2}$/, '01-01 00:00'],
    ];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      // 不動 <style> 與 <script> 的文字：CSS 裡的 #232529 這類全數字色碼也符合 /#[0-9A-Z]{6}/，
      // 換成 #ABCDEF 會讓文字色變成淡藍色（MIL-175 發現）
      const tag = node.parentElement?.tagName;
      if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'NOSCRIPT') continue;
      let text = node.nodeValue ?? '';
      for (const [pattern, sample] of replacements) text = text.replace(pattern, sample);
      if (text !== node.nodeValue) node.nodeValue = text;
    }
  });
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
}

async function shoot(page: Page, name: string, options: { fullPage?: boolean } = {}): Promise<void> {
  await settle(page);
  await normalizeVolatileText(page);
  await expect(page).toHaveScreenshot(name, {
    fullPage: options.fullPage ?? true,
    stylePath: path.join(__dirname, 'screenshot.css'),
  });
}

test('準備截圖用的資料', async ({ page }) => {
  seeded.propertyA = (await seedProperty(page, '截圖基準物件甲', '台北市大安區和平東路二段 100 號 3 樓')).id;
  seeded.propertyB = (await seedProperty(page, '截圖基準物件乙', '新北市板橋區文化路一段 200 號 5 樓')).id;
  seeded.sentContractId = await seedSendableDraft(page, seeded.propertyA);
  const sent = await page.request.post(`/api/contracts/${seeded.sentContractId}/send`);
  expect(sent.ok()).toBe(true);
  seeded.readyDraftId = await seedSendableDraft(page, seeded.propertyB);
  seeded.bareDraftId = await seedDraft(page, seeded.propertyA);
});

test('合約列表', async ({ page }) => {
  await page.goto('/contracts');
  await expect(page.getByRole('row').filter({ hasText: '截圖基準物件乙' })).toBeVisible();
  await shoot(page, 'contracts-list.png');
});

test('合約詳情（簽署中）', async ({ page }) => {
  await page.goto(`/contracts/${seeded.sentContractId}`);
  await expect(page.getByText('待乙方簽').first()).toBeVisible();
  // 等合約預覽載完，避免截到載入中的畫面
  await expect(page.getByText('載入合約 PDF…', { exact: true })).toBeHidden({ timeout: 60_000 });
  await shoot(page, 'contract-detail-signing.png');
});

test('建約精靈：第一步 選物件與範本', async ({ page }) => {
  await page.goto('/contracts/new');
  await chooseOption(page.getByRole('combobox'), /截圖基準物件甲/);
  await page.getByRole('heading', { name: '建立合約' }).click(); // 收起下拉，移開焦點
  await expect(page.getByText('台北市大安區和平東路二段 100 號 3 樓', { exact: true })).toBeVisible();
  await shoot(page, 'wizard-step1-property.png');
});

test('建約精靈：第二步 填寫欄位', async ({ page }) => {
  await page.goto(`/contracts/${seeded.bareDraftId}/edit`);
  await expect(page.getByLabel('甲方（出租人）姓名')).toBeVisible();
  await shoot(page, 'wizard-step2-fields.png');
});

test('建約精靈：第四步 確認送簽', async ({ page }) => {
  await page.goto(`/contracts/${seeded.readyDraftId}/edit`);
  await expect(page.getByRole('button', { name: /確認送簽/ })).toBeVisible();
  await shoot(page, 'wizard-step4-confirm.png');
});

test('物件列表', async ({ page }) => {
  await page.goto('/properties');
  await expect(page.getByRole('row').filter({ hasText: '截圖基準物件乙' })).toBeVisible();
  await shoot(page, 'properties-list.png');
});
