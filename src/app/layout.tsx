import type { Metadata } from 'next';
import { AntdRegistry } from '@ant-design/nextjs-registry';
import AppConfigProvider from '@/components/AppConfigProvider';
import AppShell from '@/components/AppShell';
import { loadDesignTheme } from '@/lib/design-theme-loader';
import './globals.css';

export const metadata: Metadata = {
  title: 'Rent PoC — 電子簽約物業管理',
  description: '驗證租賃合約電子簽約流程的 PoC',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
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
