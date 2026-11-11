import { test as setup, expect } from '@playwright/test';
import { signUpAsOwner } from '../helpers/login';

// 登入一次，把登入狀態存起來給 flows 與 visual 共用。
// email 與組織名稱固定：每次執行的資料庫都是全新的，固定值讓截圖上的帳號列不會變動。
// 接著逐頁走過一輪，讓 next dev 先編譯好，避免第一個測試吃掉編譯時間而逾時。

// 登入前先編譯登入會用到的頁面。dev server 編譯新路由時，已開著的頁面可能整頁重載，會洗掉輸入到一半的驗證碼。
const BEFORE_LOGIN_PATHS = ['/demo/otp', '/login'];
const AFTER_LOGIN_PATHS = ['/', '/properties', '/contracts'];
// /contracts/new 沒有入口參數時導到物件列表（MIL-209），所以放在這裡不斷言網址。參數格式正確、物件不存在，一樣導走，但頁面已編譯
const WARMUP_ONLY_PATHS = [
  '/contracts/new?property=01JD3X7Z5K8M2N4P6Q8R0S2T4V&kind=lease','/desk', '/desk/ownership/warmup', '/desk/items/warmup', '/properties/warmup', '/notifications', '/practice'];

// 流程中第一次打到才編譯的 API 路由。dev server 編譯新路由時，已開著的頁面可能整頁重載，
// 例如物件頁開「新增物件」時打 /api/registry/areas，會洗掉選到一半的下拉選單。
// /api/demo/notify 與通知已讀路由只收 POST，用 GET 預熱只會得到 405，不會建立通知，也不會改共用帳號的未讀數。
const WARMUP_API_PATHS = [
  '/api/registry/areas',
  '/api/properties',
  '/api/desk/queue?status=open',
  '/api/demo/notify',
  '/api/notifications/warmup/read',
  // 執業主體頁的流程測試（MIL-185）用到。兩條只收 POST，GET 預熱只會得到 405，不會建立資料
  '/api/onboarding/practice',
  '/api/practice/licenses',
];

setup('登入並預熱頁面', async ({ page }) => {
  setup.setTimeout(300_000);
  for (const path of BEFORE_LOGIN_PATHS) await page.goto(path);
  await signUpAsOwner(page, { email: 'e2e-owner@example.com', orgName: 'E2E 屋主' });

  for (const path of AFTER_LOGIN_PATHS) {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(path === '/' ? '' : path));
  }
  // 審核台與物件頁的新路由也要先編譯。預熱帳號不是營運者，頁面可能導走或顯示找不到，所以只 goto 等 load，不斷言網址。
  // 不預熱的話，流程測試中途第一次編譯會讓 dev server 整頁重載 /desk，打斷營運者的導覽（MIL-201）。
  for (const path of WARMUP_ONLY_PATHS) await page.goto(path).catch(() => undefined);
  for (const path of WARMUP_API_PATHS) await page.request.get(path).catch(() => undefined);
  await page.context().storageState({ path: 'e2e-results/.auth/state.json' });
});
