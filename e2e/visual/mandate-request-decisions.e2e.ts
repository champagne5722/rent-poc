import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createOwnerOrg, newUserContext, signIn } from '../baseline/session';
import { seedProperty } from '../helpers/api';
import { addVerifiedManager, startVerifiedPractice, submitRequestToPractice, type PracticeManager, type PracticeSession } from '../helpers/practice';
import { clickUntil } from '../helpers/ui';

// 截圖基準（MIL-210 前半畫面段）：業者的申請列表（含期限）、業者的詳情（待接受、接受的對話框、沒有合格的管理人員、已接受）、
// 屋主的詳情（已接受的桌面與 375px、未接受、已結束）。
// 基準只在階段驗收時由主控更新：npm run e2e:visual -- --update-snapshots
// 業者、屋主與管理人員的名稱固定。每次執行的資料庫都是全新的，所以固定值不會撞。
// 申請 ID 不出現在畫面上。時間戳、「幾月幾日前」的期限與顯示編碼每次不同，截圖前換成固定樣本。

const MOBILE = { width: 375, height: 812 };
const ACCEPT = /^接\s?受$/;
const PRACTICE_EMAIL = 'visual-decision-practice@example.com';

const ids = { pending: '', accepted: '', declined: '', ended: '', bare: '' };
const contexts: BrowserContext[] = [];
let practice: PracticeSession;
let bare: PracticeSession;
let manager: PracticeManager;
let owner: Page;

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });

async function normalizeVolatileText(page: Page): Promise<void> {
  await page.evaluate(() => {
    const replacements: Array<[RegExp, string]> = [
      [/\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/g, '2026/01/01 00:00'],
      [/\d{1,2}月\d{1,2}日/g, '1月1日'],
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
  test.setTimeout(480_000);
  practice = await startVerifiedPractice(browser, { email: PRACTICE_EMAIL, name: '截圖基準接受業者', taxId: '27182818' });
  contexts.push(practice.context);
  manager = await addVerifiedManager(browser, practice, PRACTICE_EMAIL);
  bare = await startVerifiedPractice(browser, { email: 'visual-decision-bare@example.com', name: '截圖基準無人員業者', taxId: '16180339' });
  contexts.push(bare.context);

  const ownerCtx = await newUserContext(browser);
  contexts.push(ownerCtx);
  owner = await ownerCtx.newPage();
  await signIn(owner, 'visual-decision-owner@example.com');
  await createOwnerOrg(owner, '截圖基準接受屋主');
  const names = { pending: '截圖物件甲', accepted: '截圖物件乙', declined: '截圖物件丙', ended: '截圖物件丁', bare: '截圖物件戊' };
  for (const name of Object.values(names)) await seedProperty(owner, name);

  ids.accepted = (await submitRequestToPractice(owner, practice, names.accepted)).requestId;
  ids.declined = (await submitRequestToPractice(owner, practice, names.declined)).requestId;
  ids.ended = (await submitRequestToPractice(owner, practice, names.ended)).requestId;
  ids.pending = (await submitRequestToPractice(owner, practice, names.pending)).requestId;
  ids.bare = (await submitRequestToPractice(owner, bare, names.bare)).requestId;

  const post = async (page: Page, id: string, action: string, data?: unknown) => {
    const res = await page.request.post(`/api/mandate-requests/${id}/${action}`, data === undefined ? {} : { data });
    expect(res.ok(), `${action}：${res.status()} ${await res.text()}`).toBe(true);
  };
  await post(practice.page, ids.accepted, 'accept', { manager_employment_id: manager.employmentId });
  await post(practice.page, ids.ended, 'accept', { manager_employment_id: manager.employmentId });
  await post(practice.page, ids.ended, 'end');
  await post(practice.page, ids.declined, 'decline');
});

test('業者的申請列表：待接受與已接受的期限', async () => {
  await practice.page.goto('/requests');
  await expect(practice.page.getByRole('row').filter({ hasText: '待業者接受' })).toContainText('前回覆');
  await expect(practice.page.getByRole('row').filter({ hasText: '已接受' })).toContainText('前送出合約');
  await shoot(practice.page, 'decision-list-practice.png');
});

test('業者的詳情：待接受', async () => {
  await practice.page.goto(`/requests/${ids.pending}`);
  await expect(practice.page.getByRole('button', { name: '不接受' })).toBeEnabled();
  await shoot(practice.page, 'decision-practice-pending.png');
});

test('業者的詳情：接受的對話框', async () => {
  await practice.page.goto(`/requests/${ids.pending}`);
  await clickUntil(practice.page.getByRole('button', { name: ACCEPT }), practice.page.getByRole('dialog', { name: '接受申請並指派管理人員' }));
  await expect(practice.page.getByRole('radio', { name: manager.name })).toBeVisible();
  await shoot(practice.page, 'decision-accept-dialog.png');
});

test('業者的詳情：沒有合格的管理人員', async () => {
  await bare.page.goto(`/requests/${ids.bare}`);
  await expect(bare.page.getByRole('button', { name: ACCEPT })).toBeDisabled();
  await shoot(bare.page, 'decision-no-manager.png');
});

test('業者的詳情：已接受', async () => {
  await practice.page.goto(`/requests/${ids.accepted}`);
  await expect(practice.page.getByText('下一步是擬定契約')).toBeVisible();
  await shoot(practice.page, 'decision-practice-accepted.png');
});

test('屋主的詳情：已接受，桌面', async () => {
  await owner.goto(`/requests/${ids.accepted}`);
  await expect(owner.getByText('業者已接受申請')).toBeVisible();
  await shoot(owner, 'decision-owner-accepted.png');
});

test('屋主的詳情：已接受，375px', async () => {
  await owner.setViewportSize(MOBILE);
  await owner.goto(`/requests/${ids.accepted}`);
  await expect(owner.getByRole('button', { name: '結束申請' })).toBeVisible();
  expect(await owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shoot(owner, 'decision-owner-accepted-375.png');
  await owner.setViewportSize({ width: 1440, height: 900 });
});

test('屋主的詳情：未接受', async () => {
  await owner.goto(`/requests/${ids.declined}`);
  await expect(owner.getByText('未接受時間')).toBeVisible();
  await shoot(owner, 'decision-owner-declined.png');
});

test('屋主的詳情：業者已結束', async () => {
  await owner.goto(`/requests/${ids.ended}`);
  await expect(owner.getByText('業者已結束申請').first()).toBeVisible();
  await shoot(owner, 'decision-owner-ended.png');
});
