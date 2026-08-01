import type { Metadata } from 'next';
import { AntdRegistry } from '@ant-design/nextjs-registry';
import { ConfigProvider } from 'antd';
import zhTW from 'antd/locale/zh_TW';
import AppShell from '@/components/AppShell';
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
          <ConfigProvider locale={zhTW}>
            <AppShell>{children}</AppShell>
          </ConfigProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}
