import type { Metadata } from 'next';
import { AntdRegistry } from '@ant-design/nextjs-registry';
import AppConfigProvider from '@/components/AppConfigProvider';
import AppShell from '@/components/AppShell';
import { loadDesignTheme } from '@/lib/design-theme-loader';
import './globals.css';

export const metadata: Metadata = {
  title: '租房雲端管理平台',
  description: '租賃合約電子簽約與物件管理平台',
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
