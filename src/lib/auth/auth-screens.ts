// 登入前就要看得到的畫面（MIL-103）。不套任何殼層，也不需要 session。
// 這個檔案不得 import node 內建模組：AppShell 是 client component，會一起打包進瀏覽器。

export const AUTH_SCREEN_PATHS: readonly string[] = ['/login', '/demo/otp'];

export function isAuthScreen(pathname: string): boolean {
  return AUTH_SCREEN_PATHS.includes(pathname);
}
