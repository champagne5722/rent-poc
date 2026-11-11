import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createOwnerOrg, newUserContext, signIn } from '../baseline/session';
import { seedProperty } from '../helpers/api';
import { startVerifiedPractice, type PracticeSession } from '../helpers/practice';

// 截圖基準（MIL-206 畫面段）：申請連結頁（登入前，桌面與 375px）、無效的連結、業者的申請列表、屋主的確認頁（375px）。
// 基準只在階段驗收時由主控更新：npm run e2e:visual -- --update-snapshots
// 業者的名稱與統編固定。每次執行的資料庫都是全新的，所以固定值不會撞。
// 連結的碼與申請 ID 不出現在畫面上。時間戳、顯示編碼每次不同，截圖前換成固定樣本。

const PRACTICE_NAME = '截圖基準代管公司';
const PRACTICE_TAX_ID = '31415926';
const MOBILE = { width: 375, height: 812 };

const seeded = { linkPath: '' };
const contexts: BrowserContext[] = [];
let practice: PracticeSession;

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });

async function normalizeVolatileText(page: Page): Promise<void> {
  await page.evaluate(() => {
    const replacements: Array<[RegExp, string]> = [
      [/\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/g, '2026/01/01 00:00'],
      [/[A-Z0-9]{3}-[0-9A-HJKMNP-TV-Z]{6}/g, 'F18-ABCDEF'],
    ];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const tag = node.parentElement?.tagName;
      if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'NOSCRIPT') continue;
      let text = node.nodeValue ?? '';
      for (const [pattern, sample] of replacements) text = text.replace(pattern, sample);
      if (text !== node.nodeValue) node.nodeValue = text;
    }
  });
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  await normalizeVolatileText(page);
  await expect(page).toHaveScreenshot(name, { fullPage: true, stylePath: path.join(__dirname, 'screenshot.css') });
}

test.afterAll(async () => {
  for (const context of contexts) await context.close().catch(() => undefined);
});

test('準備截圖用的資料', async ({ browser }) => {
  test.setTimeout(300_000);
  practice = await startVerifiedPractice(browser, { email: 'visual-request-practice@example.com', name: PRACTICE_NAME, taxId: PRACTICE_TAX_ID });
  contexts.push(practice.context);
  const created = await practice.page.request.post('/api/mandate-requests', { data: { kind: 'management' } });
  expect(created.status()).toBe(201);
  seeded.linkPath = ((await created.json()) as { data: { link_path: string } }).data.link_path;
});

test('申請連結頁：登入前，桌面', async ({ browser }) => {
  const context = await newUserContext(browser);
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(seeded.linkPath);
  await expect(page.getByRole('heading', { name: `${PRACTICE_NAME} 的委託管理申請` })).toBeVisible();
  await shoot(page, 'request-link-anonymous.png');
});

test('申請連結頁：登入前，375px', async ({ browser }) => {
  const context = await newUserContext(browser, { viewport: MOBILE });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(seeded.linkPath);
  await expect(page.getByRole('link', { name: '登入並繼續' })).toBeVisible();
  await shoot(page, 'request-link-anonymous-375.png');
});

test('申請連結頁：無效的連結', async ({ browser }) => {
  const context = await newUserContext(browser);
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(`/request/${'A'.repeat(43)}`);
  await expect(page.getByText('連結無效或已失效，請向業者索取新的連結')).toBeVisible();
  await shoot(page, 'request-link-invalid.png');
});

test('業者的申請列表', async () => {
  await practice.page.goto('/requests');
  await expect(practice.page.getByRole('row').filter({ hasText: '待屋主確認' })).toBeVisible();
  await shoot(practice.page, 'requests-list-practice.png');
});

test('屋主的確認頁：375px', async ({ browser }) => {
  test.setTimeout(300_000);
  const context = await newUserContext(browser, { viewport: MOBILE });
  contexts.push(context);
  const page = await context.newPage();
  await signIn(page, 'visual-request-owner@example.com');
  await createOwnerOrg(page, '截圖基準屋主');
  await seedProperty(page, '截圖基準屋主物件', '台北市大安區和平東路二段 100 號 3 樓');
  await page.goto(seeded.linkPath);
  await expect(page.getByRole('heading', { name: `${PRACTICE_NAME} 的委託管理申請` })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /截圖基準屋主物件/ })).toBeVisible();
  await shoot(page, 'request-owner-confirm-375.png');
});
