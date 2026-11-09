import { test as setup, expect } from '@playwright/test';
import { signUpAsOwner } from '../helpers/login';

// 登入一次，把登入狀態存起來給 flows 與 visual 共用。
// email 與組織名稱固定：每次執行的資料庫都是全新的，固定值讓截圖上的帳號列不會變動。
// 接著逐頁走過一輪，讓 next dev 先編譯好，避免第一個測試吃掉編譯時間而逾時。

// 登入前先編譯登入會用到的頁面。dev server 編譯新路由時，已開著的頁面可能整頁重載，會洗掉輸入到一半的驗證碼。
const BEFORE_LOGIN_PATHS = ['/demo/otp', '/login'];
const AFTER_LOGIN_PATHS = ['/', '/properties', '/contracts', '/contracts/new'];

setup('登入並預熱頁面', async ({ page }) => {
  setup.setTimeout(300_000);
  for (const path of BEFORE_LOGIN_PATHS) await page.goto(path);
  await signUpAsOwner(page, { email: 'e2e-owner@example.com', orgName: 'E2E 屋主' });

  for (const path of AFTER_LOGIN_PATHS) {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(path === '/' ? '' : path));
  }
  await page.context().storageState({ path: 'e2e-results/.auth/state.json' });
});
