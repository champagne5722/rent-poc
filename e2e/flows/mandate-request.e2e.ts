import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createOwnerOrg, createPracticeOrg, newUserContext, signIn } from '../baseline/session';
import { seedProperty, uniqueBuildingNo, uniqueSuffix } from '../helpers/api';
import { loginFromLinkPage, startVerifiedPractice, unknownRequestCode, type PracticeSession } from '../helpers/practice';
import { chooseOption, clickUntil } from '../helpers/ui';

// 流程 7：業者產生申請連結，屋主登入確認並送出申請（MIL-206 畫面段）。
// 業者在申請頁產生連結與 QR code。未登入的瀏覽器開連結頁，只看到業者的公開資訊。屋主登入、綁定、勾選租賃單位、送出。
// 業者收到站內通知，看到租賃單位的數量。屋主收回。第二個流程走代填物件資料與個資告知。
// 環境變數 MIL206_SHOTS_DIR 有值時，流程中的畫面會存成截圖（給主控驗收用，平常不設）。

const SHOTS_DIR = process.env.MIL206_SHOTS_DIR;
const MOBILE = { width: 375, height: 812 };
const DESKTOP = { width: 1440, height: 900 };

const INVALID_MESSAGE = '連結無效或已失效，請向業者索取新的連結';
/** 最小的 PDF 檔頭。伺服器端以內容判斷類型，只認開頭的 %PDF。 */
const TRANSCRIPT = { name: '第二類謄本.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%E2E 測試用謄本\n') };

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS_DIR) return;
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`), fullPage: true });
}

const contexts: BrowserContext[] = [];
let practice: PracticeSession;
let suffix: string;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  suffix = uniqueSuffix();
  practice = await startVerifiedPractice(browser, { email: `e2e-req-practice-${suffix}@example.com`, name: `E2E 代管 ${suffix}` });
  contexts.push(practice.context);
  // 新路由先編譯：dev server 編譯時，已開著的頁面可能整頁重載
  for (const route of ['/requests', '/requests/new', '/requests/warmup', '/notifications']) await practice.page.goto(route).catch(() => undefined);
  const anon = await newUserContext(browser);
  contexts.push(anon);
  await (await anon.newPage()).goto(`/request/${unknownRequestCode()}`).catch(() => undefined);
});

test.afterAll(async () => {
  for (const context of contexts) await context.close().catch(() => undefined);
});

let withdrawnLinkPath = '';

test('業者產生連結，屋主登入並送出，業者看到通知與租賃單位的數量，屋主收回', async ({ browser }) => {
  test.setTimeout(480_000);
  const pp = practice.page;

  // 業者：申請列表是空的，從列表進入產生連結
  await pp.goto('/requests');
  await expect(pp.getByRole('main').getByRole('heading', { name: '申請列表' })).toBeVisible();
  await expect(pp.getByText('還沒有申請。產生申請連結，交給屋主。')).toBeVisible();
  await shot(pp, '0-業者-申請列表-空');
  await clickUntil(pp.getByRole('button', { name: '產生申請連結' }).first(), pp.getByRole('radio', { name: '委託管理申請' }));

  // 只列已驗證業別對應的種類：只有委託管理申請，沒有住宅包租申請
  await expect(pp.getByRole('radio', { name: '住宅包租申請' })).toHaveCount(0);
  await pp.getByRole('button', { name: '產生申請連結' }).click();
  await expect(pp.getByText('離開這一頁後不能再顯示連結，需要時重新產生')).toBeVisible();
  const url = await pp.getByLabel('申請連結', { exact: true }).inputValue();
  expect(url).toMatch(/\/request\/[A-Za-z0-9_-]{43}$/);
  await expect(pp.getByLabel(/QR code/)).toBeVisible();
  await expect(pp.getByRole('button', { name: '複製連結' })).toBeVisible();
  // 沒有「寄給屋主」的功能
  await expect(pp.getByText(/寄給屋主|寄送連結|寄信給屋主/).filter({ hasNotText: '平台不寄信給屋主' })).toHaveCount(0);
  await shot(pp, '1-業者-產生連結後');
  const linkPath = new URL(url).pathname;

  // 業者：送出前的申請詳情。待屋主確認，沒有任何暗示連結有沒有被打開的字
  await pp.getByRole('button', { name: '查看這份申請' }).click();
  await pp.waitForURL(/\/requests\/[0-9A-Z]{26}$/);
  const requestId = pp.url().split('/').pop() as string;
  await expect(pp.getByRole('main').getByRole('heading', { name: '委託管理申請' })).toBeVisible();
  await expect(pp.getByText('待屋主確認').first()).toBeVisible();
  await expect(pp.getByText('等屋主確認並送出申請')).toBeVisible();
  await expect(pp.getByRole('main').getByText(/打開|開啟|綁定|瀏覽|點擊/)).toHaveCount(0);
  await expect(pp.getByRole('button', { name: /接受/ })).toHaveCount(0);
  await shot(pp, '7-業者-申請詳情-送出前');

  // 未登入的瀏覽器：連結頁只有業者的公開資訊，沒有後台的側欄
  const anonCtx = await newUserContext(browser);
  contexts.push(anonCtx);
  const anon = await anonCtx.newPage();
  await anon.goto(linkPath);
  await expect(anon.getByRole('heading', { name: `${practice.name} 的委託管理申請` })).toBeVisible();
  await expect(anon.getByText(practice.taxId)).toBeVisible();
  await expect(anon.getByText('租賃住宅代管業者')).toBeVisible();
  await expect(anon.getByRole('link', { name: '登入並繼續' })).toBeVisible();
  await expect(anon.getByText('建立合約')).toHaveCount(0);
  await expect(anon.getByRole('link', { name: '物件' })).toHaveCount(0);
  await shot(anon, '2-連結頁-登入前-桌面');
  await anon.setViewportSize(MOBILE);
  await expect(anon.getByRole('link', { name: '登入並繼續' })).toBeVisible();
  expect(await anon.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shot(anon, '3-連結頁-登入前-375');

  // 業者的帳號開自己的連結：固定訊息，不能以屋主身分綁定
  await pp.goto(linkPath);
  await expect(pp.getByText(/不能以屋主身分開啟申請連結/)).toBeVisible();
  await expect(pp.getByRole('button', { name: '送出申請' })).toHaveCount(0);

  // 屋主：已有組織與一個租賃單位，用手機的寬度開連結
  const ownerCtx = await newUserContext(browser, { viewport: MOBILE });
  contexts.push(ownerCtx);
  const owner = await ownerCtx.newPage();
  await signIn(owner, `e2e-req-owner-${suffix}@example.com`);
  await createOwnerOrg(owner, `E2E 申請屋主 ${suffix}`);
  const property = await seedProperty(owner, `E2E 申請物件 ${suffix}`);
  await owner.goto(linkPath);
  await expect(owner.getByRole('heading', { name: `${practice.name} 的委託管理申請` })).toBeVisible();
  await expect(owner.getByText('選擇要交出的租賃單位')).toBeVisible();
  // 沒有代填資料：不顯示代填區塊與個資告知
  await expect(owner.getByText('業者代填的物件資料')).toHaveCount(0);
  const unit = owner.getByRole('checkbox', { name: new RegExp(property.name) });
  await expect(unit).toBeVisible();
  // 沒選租賃單位不能送出
  await expect(owner.getByRole('button', { name: '送出申請' })).toBeDisabled();
  expect(await owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await unit.check();
  await expect(owner.getByText('已選 1 個租賃單位')).toBeVisible();
  await shot(owner, '5-屋主-確認頁-選租賃單位-375');
  await owner.getByRole('button', { name: '送出申請' }).click();
  await expect(owner.getByText('待業者接受').first()).toBeVisible();
  await expect(owner.getByRole('button', { name: '收回申請' })).toBeVisible();
  await shot(owner, '6a-屋主-送出後-連結頁-375');

  // 屋主：申請詳情（後台殼層，桌面寬度）
  await owner.setViewportSize(DESKTOP);
  await owner.goto(`/requests/${requestId}`);
  await expect(owner.getByRole('main').getByRole('heading', { name: `${practice.name} 的委託管理申請` })).toBeVisible();
  await expect(owner.getByText('等業者接受')).toBeVisible();
  await expect(owner.getByText(property.name)).toBeVisible();
  await shot(owner, '6-屋主-送出後-申請詳情');

  // 業者：站內通知與租賃單位的數量
  await pp.goto('/notifications');
  await expect(pp.getByText('收到一份委託管理申請')).toBeVisible();
  await expect(pp.getByText('含 1 個租賃單位')).toBeVisible();
  await pp.goto(`/requests/${requestId}`);
  await expect(pp.getByText('待業者接受').first()).toBeVisible();
  await expect(pp.getByText('申請含 1 個租賃單位。')).toBeVisible();
  // 業者看不到屋主的物件
  await expect(pp.getByText(property.name)).toHaveCount(0);
  await shot(pp, '8-業者-申請詳情-送出後');
  await pp.goto('/requests');
  const row = pp.getByRole('row').filter({ hasText: '委託管理申請' });
  await expect(row.getByText('待業者接受')).toBeVisible();
  await expect(row).toContainText('1 個');
  await shot(pp, '9-業者-申請列表');

  // 屋主：收回。按下先確認
  await owner.getByRole('button', { name: '收回申請' }).click();
  const confirm = owner.getByRole('dialog', { name: '收回這份申請？' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '收回申請' }).click();
  await expect(owner.getByText('已收回').first()).toBeVisible();
  await expect(owner.getByRole('button', { name: '收回申請' })).toHaveCount(0);

  // 業者：收到收回的通知，申請變成已收回
  await pp.goto('/notifications');
  await expect(pp.getByText('申請已收回')).toBeVisible();
  await pp.goto(`/requests/${requestId}`);
  await expect(pp.getByText('已收回').first()).toBeVisible();
  await expect(pp.getByText('屋主已收回申請，不需要處理')).toBeVisible();
  withdrawnLinkPath = linkPath;
});

test('無效的連結：不存在、已收回，畫面與文字完全相同', async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await newUserContext(browser);
  contexts.push(ctx);
  const page = await ctx.newPage();

  await page.goto(`/request/${unknownRequestCode()}`);
  await expect(page.getByText(INVALID_MESSAGE)).toBeVisible();
  await expect(page.getByRole('link', { name: '登入並繼續' })).toHaveCount(0);
  const unknownText = await page.locator('main').innerText();
  await shot(page, '4-無效的連結');

  expect(withdrawnLinkPath).not.toBe('');
  await page.goto(withdrawnLinkPath);
  await expect(page.getByText(INVALID_MESSAGE)).toBeVisible();
  expect(await page.locator('main').innerText()).toBe(unknownText);

  // 格式不合的碼：不是連結頁，登入閘門把沒有 session 的請求導向登入
  await page.goto('/request/short');
  await expect(page).toHaveURL(/\/login/);
});

test('代填物件資料：屋主第一次登入，確認代填資料並同意個資告知後送出', async ({ browser }) => {
  test.setTimeout(480_000);
  const pp = practice.page;
  const draftName = `E2E 代填物件 ${suffix}`;
  const draftAddress = '台北市大安區和平東路二段 100 號 3 樓';

  // 業者：產生連結，代填物件資料並代傳謄本
  await pp.goto('/requests/new');
  await expect(pp.getByRole('radio', { name: '委託管理申請' })).toBeChecked();
  await clickUntil(pp.getByRole('checkbox', { name: '替屋主代填物件資料' }), pp.getByLabel('物件名稱'));
  await pp.getByLabel('物件名稱').fill(draftName);
  await pp.getByLabel('完整地址').fill(draftAddress);
  await chooseOption(pp.getByLabel('縣市'), '臺北市');
  await chooseOption(pp.getByLabel('鄉鎮市區'), '大安區');
  await chooseOption(pp.getByLabel('段小段'), /龍泉 一/);
  await pp.getByLabel('建號', { exact: true }).fill(uniqueBuildingNo());
  await pp.getByRole('checkbox', { name: '代傳這個物件的謄本' }).check();
  await pp.locator('input[type="file"]').setInputFiles(TRANSCRIPT);
  await pp.getByLabel('主張的所有權人').fill('王大明');
  await pp.getByLabel('謄本取得時間').fill('2026-01-15');
  await pp.getByLabel('謄本取得時間').blur();
  await shot(pp, 'a-業者-產生連結-代填表單');
  await pp.getByRole('button', { name: '產生申請連結' }).click();
  await expect(pp.getByText('離開這一頁後不能再顯示連結，需要時重新產生')).toBeVisible();
  await expect(pp.getByText('謄本沒有送出')).toHaveCount(0);
  const linkPath = new URL(await pp.getByLabel('申請連結', { exact: true }).inputValue()).pathname;
  await pp.getByRole('button', { name: '查看這份申請' }).click();
  await pp.waitForURL(/\/requests\/[0-9A-Z]{26}$/);
  const requestId = pp.url().split('/').pop() as string;
  await expect(pp.getByText(draftName)).toBeVisible();
  await expect(pp.getByText('第二類謄本.pdf')).toBeVisible();
  await shot(pp, 'b-業者-申請詳情-有代填資料');

  // 屋主：第一次登入，用手機的寬度。登入前的連結頁沒有任何物件資料
  const ownerCtx = await newUserContext(browser, { viewport: MOBILE });
  contexts.push(ownerCtx);
  const owner = await ownerCtx.newPage();
  await owner.goto(linkPath);
  await expect(owner.getByRole('heading', { name: `${practice.name} 的委託管理申請` })).toBeVisible();
  await expect(owner.getByText(draftName)).toHaveCount(0);
  await expect(owner.getByText(draftAddress)).toHaveCount(0);
  await loginFromLinkPage(owner, `e2e-req-first-${suffix}@example.com`);

  // 還沒有組織：先建立屋主帳號，與綁定一起完成
  await expect(owner.getByText('第一次使用，請先建立屋主帳號')).toBeVisible();
  await shot(owner, 'c-屋主-建立屋主帳號-375');
  await owner.getByLabel('屋主名稱').fill(`E2E 第一次屋主 ${suffix}`);
  await owner.getByRole('button', { name: '建立屋主帳號並繼續' }).click();

  // 確認頁：最上方是哪一家業者的哪一種申請，代填資料與個資告知
  await expect(owner.getByRole('heading', { name: `${practice.name} 的委託管理申請` })).toBeVisible();
  await expect(owner.getByText('業者代填的物件資料')).toBeVisible();
  await expect(owner.getByText(draftName)).toBeVisible();
  await expect(owner.getByText(draftAddress)).toBeVisible();
  await expect(owner.getByRole('heading', { level: 3 })).toBeVisible();
  await expect(owner.getByText('業者代傳了這個物件的謄本')).toBeVisible();
  await expect(owner.getByRole('button', { name: '同意並確認資料' })).toBeVisible();
  await expect(owner.getByRole('button', { name: '不同意，仍確認資料' })).toBeVisible();
  // 確認前沒有可選的租賃單位
  await expect(owner.getByText('確認上面的代填資料後，物件會出現在這裡')).toBeVisible();
  expect(await owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shot(owner, '5-屋主-確認頁-代填與個資告知');

  await owner.getByRole('button', { name: '同意並確認資料' }).click();
  await expect(owner.getByText('已確認，這個物件已登錄在你的帳號')).toBeVisible();
  await expect(owner.getByText('業者代傳的謄本已轉成你的謄本')).toBeVisible();
  const unit = owner.getByRole('checkbox', { name: new RegExp(draftName) });
  await expect(unit).toBeChecked();
  await shot(owner, 'd-屋主-確認代填資料後-375');
  await owner.getByRole('button', { name: '送出申請' }).click();
  await expect(owner.getByText('待業者接受').first()).toBeVisible();

  // 物件登錄在屋主的組織
  await owner.setViewportSize(DESKTOP);
  await owner.goto('/properties');
  await expect(owner.getByRole('link', { name: draftName }).first()).toBeVisible();

  // 業者：租賃單位的數量，代填資料已刪除
  await pp.goto(`/requests/${requestId}`);
  await expect(pp.getByText('申請含 1 個租賃單位。')).toBeVisible();
  await expect(pp.getByText('沒有代填資料，或資料已刪除')).toBeVisible();
  await expect(pp.getByText(draftName)).toHaveCount(0);
});

test('業別都沒驗證：不顯示表單，說明要先完成業別的核對', async ({ browser }) => {
  test.setTimeout(240_000);
  const ctx = await newUserContext(browser);
  contexts.push(ctx);
  const page = await ctx.newPage();
  const other = uniqueSuffix();
  await signIn(page, `e2e-req-unverified-${other}@example.com`);
  await createPracticeOrg(page, { name: `E2E 未核對代管 ${other}`, taxId: String(Date.now()).slice(-8), entityType: 'company', kinds: ['management'] });
  await page.goto('/requests/new');
  await expect(page.getByText('還沒有通過驗證的代管業或包租業')).toBeVisible();
  await expect(page.getByRole('radio')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '前往執業主體' })).toBeVisible();
  await shot(page, 'e-業者-業別未驗證');
});
