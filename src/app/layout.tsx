import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { AntdRegistry } from '@ant-design/nextjs-registry';
import AppConfigProvider from '@/components/AppConfigProvider';
import AppShell from '@/components/AppShell';
import { PATH_HEADER } from '@/lib/auth/config';
import { isSessionExemptPath } from '@/lib/auth/session-gate';
import { requestContext } from '@/lib/current-request-context';
import { loadDesignTheme } from '@/lib/design-theme-loader';
import { Unauthenticated } from '@/lib/request-context';
import './globals.css';

export const metadata: Metadata = {
  title: '租房雲端管理平台',
  description: '租賃合約電子簽約與物件管理平台',
};

/**
 * 整頁載入時驗證登入（MIL-103）。proxy 只檢查 cookie 在不在，這裡才查 session 與成員資格，
 * 失效的 session（登出後的舊 cookie、被移出組織）在重新整理時被導向登入頁。
 * layout 在 client 端換頁時不會重跑，換頁後的資料請求靠各 route 的 requestContext() 把關。
 */
async function requireLogin(): Promise<void> {
  const pathname = (await headers()).get(PATH_HEADER) ?? '/';
  if (isSessionExemptPath(pathname)) return;
  try {
    await requestContext();
  } catch (error) {
    if (!(error instanceof Unauthenticated)) throw error;
    // redirect() 靠丟例外運作，不能放在 try 裡
    redirect(error.reason === 'no_identity' ? '/login?notice=no-identity' : '/login');
  }
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await requireLogin();
  return (
    <html lang="zh-Hant-TW">
      <body>
        <AntdRegistry>
          <AppConfigProvider design={loadDesignTheme()}>
            <AppShell>{children}</AppShell>
          </AppConfigProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}
