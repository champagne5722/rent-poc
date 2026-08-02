'use client';

import { ConfigProvider } from 'antd';
import zhTW from 'antd/locale/zh_TW';
import { toAntdTheme, type DesignTheme } from '@/lib/design-theme';

export default function AppConfigProvider({
  design,
  children,
}: Readonly<{ design: DesignTheme | undefined; children: React.ReactNode }>) {
  return (
    <ConfigProvider locale={zhTW} theme={toAntdTheme(design)}>
      {children}
    </ConfigProvider>
  );
}
