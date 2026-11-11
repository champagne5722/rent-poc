// 登入前就要看得到的畫面（MIL-103）。不套任何殼層，也不需要 session。
// 這個檔案不得 import node 內建模組：AppShell 是 client component，會一起打包進瀏覽器。

export const AUTH_SCREEN_PATHS: readonly string[] = ['/login', '/demo/otp'];

/**
 * 申請連結頁（MIL-206）：屋主掃 QR code 或點連結時還沒有登入，頁面不能套用登入後的側欄與頁首。
 * 碼固定 43 個字元（base64url）。格式不合的路徑不算連結頁，仍然套後台殼層，登入閘門會擋下沒有 session 的請求。
 */
const REQUEST_LINK_PAGE = /^\/request\/[A-Za-z0-9_-]{43}$/;

export function isRequestLinkPage(pathname: string): boolean {
  return REQUEST_LINK_PAGE.test(pathname);
}

export function isAuthScreen(pathname: string): boolean {
  return AUTH_SCREEN_PATHS.includes(pathname) || isRequestLinkPage(pathname);
}
