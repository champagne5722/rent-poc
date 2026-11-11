import { describe, expect, it } from 'vitest';
import { isAuthScreen, isRequestLinkPage } from './auth-screens';

// 登入前的畫面不套任何殼層（MIL-103）。申請連結頁（MIL-206）屋主掃 QR code 進來時還沒登入，同樣不能套後台的側欄與頁首。

const CODE = 'a-_Z9'.repeat(8) + 'abc'; // 43 個字元

describe('申請連結頁', () => {
  it('碼是 43 個 base64url 字元的 /request/<碼> 是連結頁，也是登入前的畫面', () => {
    expect(CODE).toHaveLength(43);
    expect(isRequestLinkPage(`/request/${CODE}`)).toBe(true);
    expect(isAuthScreen(`/request/${CODE}`)).toBe(true);
  });

  it.each([
    '/request',
    '/request/',
    '/request/short',
    `/request/${CODE}x`,
    `/request/${CODE}/`,
    `/request/${CODE}/extra`,
    `/requests/${CODE}`,
    '/requests',
    '/requests/new',
    `/request/${CODE.slice(0, 42)}!`,
  ])('%s 不是連結頁，仍套後台殼層', (pathname) => {
    expect(isRequestLinkPage(pathname)).toBe(false);
    expect(isAuthScreen(pathname)).toBe(false);
  });

  it('登入頁與 demo 驗證碼頁維持原樣', () => {
    expect(isAuthScreen('/login')).toBe(true);
    expect(isAuthScreen('/demo/otp')).toBe(true);
    expect(isAuthScreen('/properties')).toBe(false);
  });
});
