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

// MIL-210 前半畫面段的資料準備。只做加法。前置條件走既有的 API，被測的行為一律走畫面。

/** 流水號。同一次執行內，每位管理人員的證號序號互不相同。 */
let certificateCounter = 0;

export interface PracticeManager {
  /** 候選名單上顯示的姓名。 */
  name: string;
  employmentId: string;
}

const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/**
 * 替已驗證的業者登錄一位租賃住宅管理人員：登入的使用者同意個資告知、登錄證書與任職，平台營運者核對證書與任職。
 * 回傳後，業者的候選名單有這一位。email 的前半段是審核台項目上的登錄人名稱。
 */
export async function addVerifiedManager(browser: Browser, session: PracticeSession, email: string): Promise<PracticeManager> {
  certificateCounter += 1;
  const serial = String(Date.now() % 1_000_000).padStart(6, '0') + String(certificateCounter % 10);
  const page = session.page;
  const consent = await page.request.post('/api/practitioner/consent', { data: { decision: 'agree' } });
  expect(consent.ok(), `同意個資告知：${consent.status()}`).toBe(true);
  const cert = await page.request.post('/api/practitioner/certificates', {
    multipart: {
      certificateKind: 'rental_housing_manager',
      certYear: '112',
      certWord: '內授營',
      certSerial: serial,
      issuedOn: '2026-06-30',
      validUntil: '2030-06-30',
      startedOn: '2026-07-01',
      files: { name: 'cert.png', mimeType: 'image/png', buffer: TINY_PNG },
    },
  });
  expect(cert.ok(), `登錄證書：${cert.status()} ${await cert.text()}`).toBe(true);

  const operator = await operatorPageOf(browser);
  const partyName = email.split('@')[0];
  // 證書核對後，任職項目才能核對，所以分兩輪
  for (const type of ['certificate', 'employment']) {
    let itemId: string | undefined;
    await expect(async () => {
      const items = await deskQueue(operator);
      itemId = items.find((i) => i.type === type && i.summary?.partyName === partyName)?.id;
      expect(itemId).toBeDefined();
    }).toPass({ timeout: 20_000 });
    await checkItem(operator, itemId as string, 'credential');
  }

  const candidates = await page.request.get('/api/mandate-requests/manager-candidates');
  expect(candidates.ok()).toBe(true);
  const list = ((await candidates.json()) as { data: Array<{ employment_id: string; display_name: string }> }).data;
  expect(list.length).toBeGreaterThan(0);
  return { name: list[0].display_name, employmentId: list[0].employment_id };
}

export interface SubmittedRequest {
  requestId: string;
  linkPath: string;
}

/**
 * 業者產生連結，屋主用 API 綁定並選一個物件送出，申請變成待業者接受。
 * 屋主的頁面必須已登入屋主組織。每份申請用不同的物件：同一個租賃單位同時只能在一份進行中的申請。
 */
export async function submitRequestToPractice(
  owner: Page,
  practice: PracticeSession,
  propertyName: string,
  kind: 'management' | 'master_lease' = 'management',
): Promise<SubmittedRequest> {
  const created = await practice.page.request.post('/api/mandate-requests', { data: { kind } });
  expect(created.status(), `產生連結：${await created.text()}`).toBe(201);
  const { id, link_path: linkPath } = ((await created.json()) as { data: { id: string; link_path: string } }).data;
  const code = linkPath.split('/').pop() as string;
  const claim = await owner.request.post(`/api/mandate-requests/link/${code}/claim`, { data: {} });
  expect(claim.ok(), `綁定連結：${claim.status()} ${await claim.text()}`).toBe(true);
  const groups = (await (await owner.request.get('/api/properties?group=object')).json()) as {
    data: Array<{ units: Array<{ name: string; rental_unit_id: string }> }>;
  };
  const unit = groups.data.flatMap((g) => g.units).find((u) => u.name === propertyName);
  expect(unit, `找不到物件 ${propertyName}`).toBeDefined();
  const submit = await owner.request.post(`/api/mandate-requests/${id}/submit`, { data: { unit_ids: [unit!.rental_unit_id] } });
  expect(submit.ok(), `送出申請：${submit.status()} ${await submit.text()}`).toBe(true);
  return { requestId: id, linkPath };
}
