import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

// 現況基準（MIL-170）的登入與多身分工具。
// 一個瀏覽器開多個 context，每個 context 是一位使用者。登入走 email 驗證碼流程，與 e2e/helpers/login.ts 相同，
// 但這裡的使用者可能已經有身分（營運者），也可能要等一下才有身分，所以登入後只等「離開登入頁」或「進入無身分提示」。

const OTP_LENGTH = 6;
const FIXED_NOW = new Date('2026-11-10T10:00:00+08:00');

export const FIXED_ENVIRONMENT = {
  baseURL: process.env.BASE_URL ?? 'http://localhost:3410',
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  timezoneId: 'Asia/Taipei',
  locale: 'zh-TW',
  colorScheme: 'light' as const,
};

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

/** 開一個新的 context，瀏覽器端時間固定在 2026-11-10 10:00（台北），與 E2E 截圖基準一致。 */
export async function newUserContext(
  browser: Browser,
  options: { storageState?: string; viewport?: { width: number; height: number } } = {},
): Promise<BrowserContext> {
  const context = await browser.newContext({
    ...FIXED_ENVIRONMENT,
    viewport: options.viewport ?? FIXED_ENVIRONMENT.viewport,
    storageState: options.storageState,
  });
  await context.clock.setFixedTime(FIXED_NOW);
  return context;
}

/** 用 email 驗證碼登入。回傳登入後的網址。第一次登入的 email 會停在 /login?notice=no-identity。 */
export async function signIn(page: Page, email: string): Promise<string> {
  await expect(async () => {
    await page.goto('/login');
    // 已經登入的 context 會被導走
    if (!new URL(page.url()).pathname.startsWith('/login')) return;
    await page.getByLabel('email').fill(email);
    await page.getByRole('button', { name: '寄送驗證碼' }).click();
    await expect(page.getByText('驗證碼已寄出')).toBeVisible({ timeout: 5_000 });
    const code = await readOtpFor(page, email);
    await page.keyboard.type(code);
    await page.waitForURL((url) => !url.pathname.startsWith('/login') || url.search.includes('notice=no-identity'), { timeout: 15_000 });
  }).toPass({ timeout: 150_000 });
  return page.url();
}

/** 第一次登入的帳號建屋主組織。 */
export async function createOwnerOrg(page: Page, orgName: string): Promise<void> {
  const response = await page.request.post('/api/onboarding/owner', { data: { name: orgName } });
  if (!response.ok()) throw new Error(`建立屋主組織失敗：${response.status()} ${await response.text()}`);
}

/** 第一次登入的帳號建執業主體組織。統編 8 碼數字，業別至少一個。 */
export async function createPracticeOrg(
  page: Page,
  options: { name: string; taxId: string; entityType: 'company' | 'firm'; kinds: Array<'management' | 'master_lease' | 'brokerage'> },
): Promise<void> {
  const response = await page.request.post('/api/onboarding/practice', { data: options });
  if (!response.ok()) throw new Error(`建立執業主體失敗：${response.status()} ${await response.text()}`);
}
