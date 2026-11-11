import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { checkItem, deskQueue, submitLicense } from '../baseline/seed';
import { createPracticeOrg, newUserContext, signIn } from '../baseline/session';

// 業者與申請連結的測試資料準備（MIL-206 畫面段）。只做加法，不改既有的 helper。
// 前置條件走既有的 API：業者登錄執業主體、送出代管業別，平台營運者在審核台核對相符。被測的行為一律走畫面。

const OPERATOR_EMAIL = process.env.BASELINE_OPERATOR_EMAIL ?? 'e2e-operator@example.com';
const OTP_LENGTH = 6;

/** 每個瀏覽器只登入營運者一次。 */
const operatorPages = new WeakMap<Browser, Promise<Page>>();

function operatorPageOf(browser: Browser): Promise<Page> {
  let pending = operatorPages.get(browser);
  if (!pending) {
    pending = (async () => {
      const context = await newUserContext(browser);
      const page = await context.newPage();
      await signIn(page, OPERATOR_EMAIL);
      return page;
    })();
    operatorPages.set(browser, pending);
  }
  return pending;
}

export interface PracticeSession {
  context: BrowserContext;
  page: Page;
  name: string;
  taxId: string;
}

/** 8 碼統編。同一次執行內互不相同，審核台用它找出這家業者的項目。 */
function uniqueTaxId(): string {
  return String(Date.now()).slice(-8);
}

/**
 * 開一個新的瀏覽器環境，登入並建立代管業者的組織，營運者核對委託管理業別相符。
 * 回傳的 page 已登入，組織是業者，委託管理申請能產生連結。
 */
export async function startVerifiedPractice(browser: Browser, options: { email: string; name: string; taxId?: string }): Promise<PracticeSession> {
  const context = await newUserContext(browser);
  const page = await context.newPage();
  const taxId = options.taxId ?? uniqueTaxId();
  await signIn(page, options.email);
  await createPracticeOrg(page, { name: options.name, taxId, entityType: 'company', kinds: ['management'] });
  await submitLicense(page, 'management', `北市租管字第 ${taxId} 號`);

  const operator = await operatorPageOf(browser);
  let itemId: string | undefined;
  await expect(async () => {
    const items = await deskQueue(operator);
    itemId = items.find((i) => i.type === 'license' && i.summary?.taxId === taxId)?.id;
    expect(itemId).toBeDefined();
  }).toPass({ timeout: 20_000 });
  await checkItem(operator, itemId as string, 'license');
  return { context, page, name: options.name, taxId };
}

async function readOtpFor(page: Page, email: string): Promise<string> {
  let code: string | undefined;
  await expect(async () => {
    const html = await (await page.request.get('/demo/otp')).text();
    const rows = html.match(/<tr[\s\S]*?<\/tr>/g) ?? [];
    const row = rows.find((r) => r.includes(email));
    code = row?.match(new RegExp(`>(\\d{${OTP_LENGTH}})<`))?.[1];
    expect(code).toBeDefined();
  }).toPass({ timeout: 20_000 });
  return code as string;
}

/**
 * 在「登入並繼續」把頁面帶到登入頁之後，用 email 驗證碼登入，等回到連結頁。
 * dev server 編譯路由時頁面可能重載，所以整段能重做：每次重試都重新開登入頁。
 */
export async function loginFromLinkPage(page: Page, email: string): Promise<void> {
  await page.getByRole('link', { name: '登入並繼續' }).click();
  await page.waitForURL(/\/login\?next=/);
  const loginUrl = page.url();
  await expect(async () => {
    if (!page.url().startsWith(loginUrl.split('?')[0])) await page.goto(loginUrl);
    await page.getByLabel('email').fill(email);
    await page.getByRole('button', { name: '寄送驗證碼' }).click();
    await expect(page.getByText('驗證碼已寄出')).toBeVisible({ timeout: 5_000 });
    const code = await readOtpFor(page, email);
    // 輸入框自動聚焦，填滿 6 碼會自動送出
    await page.keyboard.type(code);
    await page.waitForURL(/\/request\//, { timeout: 15_000 });
  }).toPass({ timeout: 150_000 });
}

/** 43 個字元的碼，格式合法但不存在。 */
export function unknownRequestCode(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  for (let i = 0; i < 43; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}
