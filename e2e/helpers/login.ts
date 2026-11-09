import { expect, type Page } from '@playwright/test';

// 登入走系統的 email 驗證碼流程（ADR-0022）：到登入頁輸入 email，再從 demo 驗證碼頁（/demo/otp）取碼。
// 不碰應用程式碼，也不直接寫 session。

const OTP_LENGTH = 6;

/**
 * 讀 demo 驗證碼頁（/demo/otp），取出寄給這個 email 的最新驗證碼。
 * 用 HTTP 請求讀，不另開分頁：dev server 編譯分頁時，已開著的登入頁可能整頁重載，會洗掉輸入到一半的驗證碼。
 */
async function readOtpFor(page: Page, email: string): Promise<string> {
  let code: string | undefined;
  await expect(async () => {
    const html = await (await page.request.get('/demo/otp')).text();
    // 每列依序是時間、收件人、種類、驗證碼，新的在前
    const rows = html.match(/<tr[\s\S]*?<\/tr>/g) ?? [];
    const row = rows.find((r) => r.includes(email));
    code = row?.match(new RegExp(`>(\\d{${OTP_LENGTH}})<`))?.[1];
    expect(code).toBeDefined();
  }).toPass({ timeout: 20_000 });
  return code as string;
}

/**
 * 用新的 email 登入，並建立屋主組織。每次執行都用不同的 email 與組織名稱，不依賴既有資料。
 *
 * dev server 編譯路由時，開著的頁面可能整頁重載或還沒 hydrate，按鈕會變成原生表單送出。
 * 所以每個階段都能整段重做，用 toPass 重試，不靠固定等待。
 */
export async function signUpAsOwner(page: Page, options: { email: string; orgName: string }): Promise<void> {
  // 階段一：用 email 登入。成功後網址會落在「還沒有身分」的登入頁
  await expect(async () => {
    await page.goto('/login');
    await page.getByLabel('email').fill(options.email);
    await page.getByRole('button', { name: '寄送驗證碼' }).click();
    await expect(page.getByText('驗證碼已寄出')).toBeVisible({ timeout: 5_000 });
    const code = await readOtpFor(page, options.email);
    // 輸入框自動聚焦，填滿 6 碼會自動送出
    await page.keyboard.type(code);
    await page.waitForURL(/notice=no-identity/, { timeout: 15_000 });
  }).toPass({ timeout: 150_000 });

  // 階段二：第一次登入的帳號還沒有身分，選屋主並建立組織
  await expect(async () => {
    await page.goto('/login');
    // 已經有身分時，登入頁會直接導向落地頁
    if (!new URL(page.url()).pathname.startsWith('/login')) return;
    await page.getByRole('button', { name: /我是屋主/ }).click({ timeout: 5_000 });
    await page.getByLabel('組織名稱').fill(options.orgName, { timeout: 5_000 });
    await page.getByRole('button', { name: '建立屋主組織' }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 });
  }).toPass({ timeout: 60_000 });
}
