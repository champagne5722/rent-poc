import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createOwnerOrg, newUserContext, signIn } from '../baseline/session';
import { seedProperty, uniqueSuffix } from '../helpers/api';
import { addVerifiedManager, startVerifiedPractice, submitRequestToPractice, type PracticeManager, type PracticeSession } from '../helpers/practice';
import { clickUntil } from '../helpers/ui';

// 流程 8：業者接受、不接受與結束屋主的申請（MIL-210 前半畫面段）。
// 流程一：屋主送出，業者的組織管理員接受並指派管理人員，屋主看到通知與「已接受」，屋主結束，業者看到通知與「已結束」。
// 流程二：業者不接受，屋主看到「未接受」，畫面沒有原因。
// 流程三：業者沒有合格的管理人員，「接受」停用並有說明。
// 流程四：業者結束已接受的申請，屋主看到「業者已結束申請」。
// 資料準備（業者核對、管理人員、屋主送出）走 API，被測的接受、不接受、結束一律走畫面。
// 環境變數 MIL210A_SHOTS_DIR 有值時，流程中的畫面會存成截圖（給主控驗收用，平常不設）。

const SHOTS_DIR = process.env.MIL210A_SHOTS_DIR;
const MOBILE = { width: 375, height: 812 };
const DESKTOP = { width: 1440, height: 900 };

/** antd 在兩個中文字的按鈕文字中間補一個空白，「接受」的名稱是「接 受」。 */
const ACCEPT = /^接\s?受$/;

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS_DIR) return;
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`), fullPage: true });
}

const contexts: BrowserContext[] = [];
let suffix: string;
let practice: PracticeSession;
let manager: PracticeManager;
let bare: PracticeSession;
let owner: Page;
const properties: Record<string, { name: string }> = {};

test.beforeAll(async ({ browser }) => {
  test.setTimeout(480_000);
  suffix = uniqueSuffix();
  const practiceEmail = `e2e-dec-practice-${suffix}@example.com`;
  practice = await startVerifiedPractice(browser, { email: practiceEmail, name: `E2E 接受業者 ${suffix}` });
  contexts.push(practice.context);
  manager = await addVerifiedManager(browser, practice, practiceEmail);
  bare = await startVerifiedPractice(browser, { email: `e2e-dec-bare-${suffix}@example.com`, name: `E2E 無人員業者 ${suffix}` });
  contexts.push(bare.context);

  const ownerCtx = await newUserContext(browser);
  contexts.push(ownerCtx);
  owner = await ownerCtx.newPage();
  await signIn(owner, `e2e-dec-owner-${suffix}@example.com`);
  await createOwnerOrg(owner, `E2E 接受屋主 ${suffix}`);
  for (const key of ['accept', 'decline', 'bare', 'practiceEnd']) {
    properties[key] = await seedProperty(owner, `E2E ${key} 物件 ${suffix}`);
  }
  // 新路由先編譯：dev server 編譯時，已開著的頁面可能整頁重載
  for (const page of [practice.page, owner]) {
    for (const route of ['/requests', '/requests/warmup', '/notifications']) await page.goto(route).catch(() => undefined);
  }
});

test.afterAll(async () => {
  for (const context of contexts) await context.close().catch(() => undefined);
});

test('業者接受並指派管理人員，屋主看到通知與已接受，屋主結束，業者看到通知與已結束', async () => {
  test.setTimeout(480_000);
  const pp = practice.page;
  const { requestId } = await submitRequestToPractice(owner, practice, properties.accept.name);

  // 業者的申請列表：待業者接受，期限是幾月幾日前回覆
  await pp.goto('/requests');
  const row = pp.getByRole('row').filter({ hasText: '委託管理申請' });
  await expect(row.getByText('待業者接受')).toBeVisible();
  await expect(row).toContainText(/\d{1,2}月\d{1,2}日前回覆/);
  await shot(pp, '1-業者-申請列表-待接受');

  // 業者的詳情：兩個按鈕，沒有物件的資料
  await pp.goto(`/requests/${requestId}`);
  await expect(pp.getByRole('main').getByRole('heading', { name: '委託管理申請' })).toBeVisible();
  await expect(pp.getByText('屋主已送出申請，等你回覆')).toBeVisible();
  await expect(pp.getByRole('button', { name: ACCEPT })).toBeEnabled();
  await expect(pp.getByRole('button', { name: '不接受' })).toBeEnabled();
  await expect(pp.getByText(properties.accept.name)).toHaveCount(0);
  await shot(pp, '2-業者-詳情-待接受');

  // 接受的對話框：必須選一位管理人員才能送出
  await clickUntil(pp.getByRole('button', { name: ACCEPT }), pp.getByRole('dialog', { name: '接受申請並指派管理人員' }));
  const dialog = pp.getByRole('dialog', { name: '接受申請並指派管理人員' });
  await expect(dialog.getByRole('button', { name: '接受申請' })).toBeDisabled();
  await expect(dialog.getByRole('radio', { name: manager.name })).toBeVisible();
  await shot(pp, '3-業者-接受的對話框');
  await dialog.getByRole('radio', { name: manager.name }).check();
  await expect(dialog.getByRole('button', { name: '接受申請' })).toBeEnabled();
  await dialog.getByRole('button', { name: '接受申請' }).click();

  // 已接受：接受時間、指派的管理人員、送出合約的期限、結束申請。不放還不能用的按鈕，沒有物件的資料
  await expect(pp.getByText('下一步是擬定契約')).toBeVisible();
  await expect(pp.getByText('已接受').first()).toBeVisible();
  await expect(pp.getByText('指派的管理人員')).toBeVisible();
  await expect(pp.getByRole('main').getByText(manager.name)).toBeVisible();
  await expect(pp.getByText('接受時間')).toBeVisible();
  await expect(pp.getByText(/\d{1,2}月\d{1,2}日前送出合約/).first()).toBeVisible();
  await expect(pp.getByRole('button', { name: '結束申請' })).toBeVisible();
  await expect(pp.getByRole('button', { name: ACCEPT })).toHaveCount(0);
  await expect(pp.getByRole('main').getByText(/查看物件|擬定合約|擬約|建立合約/).filter({ hasNotText: '下一步是擬定契約' })).toHaveCount(0);
  await expect(pp.getByRole('main').getByRole('link', { name: /物件|擬約|合約/ })).toHaveCount(0);
  await expect(pp.getByText(properties.accept.name)).toHaveCount(0);
  await expect(pp.getByRole('main').getByText(/租賃單位/)).toHaveCount(0);
  await shot(pp, '5-業者-詳情-已接受');
  await pp.goto('/requests');
  await expect(pp.getByRole('row').filter({ hasText: '已接受' })).toContainText(/\d{1,2}月\d{1,2}日前送出合約/);

  // 屋主：通知、已接受與接受時間，看不到管理人員
  await owner.goto('/notifications');
  await expect(owner.getByText('申請已接受').first()).toBeVisible();
  await owner.goto(`/requests/${requestId}`);
  await expect(owner.getByText('業者已接受申請')).toBeVisible();
  await expect(owner.getByText('已接受').first()).toBeVisible();
  await expect(owner.getByText('接受時間')).toBeVisible();
  await expect(owner.getByRole('main').getByText(manager.name)).toHaveCount(0);
  await expect(owner.getByRole('main').getByText('管理人員')).toHaveCount(0);
  await expect(owner.getByRole('button', { name: '結束申請' })).toBeVisible();
  await shot(owner, '6-屋主-詳情-已接受-桌面');
  await owner.setViewportSize(MOBILE);
  await expect(owner.getByRole('button', { name: '結束申請' })).toBeVisible();
  await shot(owner, '7-屋主-詳情-已接受-375');
  expect(await owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // 屋主結束：按下先確認，375px 的對話框要能用
  await owner.getByRole('button', { name: '結束申請' }).click();
  const confirm = owner.getByRole('dialog', { name: '結束這份申請？' });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole('button', { name: '結束申請' })).toBeInViewport();
  await expect(confirm.getByRole('button', { name: '先不要' })).toBeInViewport();
  await shot(owner, '8-屋主-結束的確認-375');
  await confirm.getByRole('button', { name: '結束申請' }).click();
  await expect(owner.getByText('你已結束申請').first()).toBeVisible();
  await expect(owner.getByRole('button', { name: '結束申請' })).toHaveCount(0);
  await owner.setViewportSize(DESKTOP);

  // 業者：通知與已結束
  await pp.goto('/notifications');
  await expect(pp.getByText('屋主已結束申請').first()).toBeVisible();
  await pp.goto(`/requests/${requestId}`);
  await expect(pp.getByText('已結束').first()).toBeVisible();
  await expect(pp.getByText('屋主已結束申請，不需要處理')).toBeVisible();
  await expect(pp.getByRole('button', { name: '結束申請' })).toHaveCount(0);
  await shot(pp, '9-業者-詳情-屋主已結束');
});

test('業者不接受，屋主看到未接受，畫面沒有原因', async () => {
  test.setTimeout(240_000);
  const pp = practice.page;
  const { requestId } = await submitRequestToPractice(owner, practice, properties.decline.name);

  await pp.goto(`/requests/${requestId}`);
  await clickUntil(pp.getByRole('button', { name: '不接受' }), pp.getByRole('dialog', { name: '不接受這份申請？' }));
  const confirm = pp.getByRole('dialog', { name: '不接受這份申請？' });
  // 確認文字寫明屋主只看到「未接受」，沒有填原因的欄位
  await expect(confirm.getByText(/屋主只會看到「未接受」/)).toBeVisible();
  await expect(confirm.getByRole('textbox')).toHaveCount(0);
  await shot(pp, '10-業者-不接受的確認');
  await confirm.getByRole('button', { name: '不接受' }).click();
  await expect(pp.getByText('申請未接受，不需要處理')).toBeVisible();
  await expect(pp.getByRole('button', { name: '不接受' })).toHaveCount(0);
  await expect(pp.getByRole('button', { name: ACCEPT })).toHaveCount(0);

  // 屋主：通知與詳情只有「未接受」與時間
  await owner.goto('/notifications');
  await expect(owner.getByText('申請未接受').first()).toBeVisible();
  await owner.goto(`/requests/${requestId}`);
  await expect(owner.getByText('未接受').first()).toBeVisible();
  await expect(owner.getByText('未接受時間')).toBeVisible();
  await expect(owner.getByRole('button', { name: '結束申請' })).toHaveCount(0);
  const text = await owner.getByRole('main').innerText();
  expect(text).not.toMatch(/原因|理由|因為/);
  await expect(owner.getByRole('main').getByText(manager.name)).toHaveCount(0);
  await shot(owner, '11-屋主-詳情-未接受');
});

test('業者沒有合格的管理人員：接受停用並說明，不接受仍能用', async () => {
  test.setTimeout(240_000);
  const pb = bare.page;
  const { requestId } = await submitRequestToPractice(owner, bare, properties.bare.name);
  await pb.goto(`/requests/${requestId}`);
  await expect(pb.getByText('屋主已送出申請，等你回覆')).toBeVisible();
  await expect(pb.getByRole('button', { name: ACCEPT })).toBeDisabled();
  await expect(pb.getByRole('button', { name: '不接受' })).toBeEnabled();
  await expect(pb.getByText(/沒有通過核對的租賃住宅管理人員/)).toBeVisible();
  await expect(pb.getByRole('link', { name: '前往執業主體' })).toHaveAttribute('href', '/practice');
  await shot(pb, '4-業者-沒有合格的管理人員');
});

test('業者結束已接受的申請，屋主看到業者已結束申請', async () => {
  test.setTimeout(240_000);
  const pp = practice.page;
  const { requestId } = await submitRequestToPractice(owner, practice, properties.practiceEnd.name);
  const accept = await pp.request.post(`/api/mandate-requests/${requestId}/accept`, { data: { manager_employment_id: manager.employmentId } });
  expect(accept.ok(), `接受：${accept.status()} ${await accept.text()}`).toBe(true);

  await pp.goto(`/requests/${requestId}`);
  await clickUntil(pp.getByRole('button', { name: '結束申請' }), pp.getByRole('dialog', { name: '結束這份申請？' }));
  const confirm = pp.getByRole('dialog', { name: '結束這份申請？' });
  await expect(confirm.getByRole('textbox')).toHaveCount(0);
  await confirm.getByRole('button', { name: '結束申請' }).click();
  await expect(pp.getByText('你的組織已結束申請，不需要處理')).toBeVisible();

  await owner.goto('/notifications');
  await expect(owner.getByText('業者已結束申請').first()).toBeVisible();
  await owner.goto(`/requests/${requestId}`);
  await expect(owner.getByText('業者已結束申請').first()).toBeVisible();
  await expect(owner.getByText('已結束').first()).toBeVisible();
  await expect(owner.getByRole('main').getByText(manager.name)).toHaveCount(0);
  await shot(owner, '12-屋主-詳情-業者已結束');
});
