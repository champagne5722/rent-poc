'use client';

import { Flex } from 'antd';
import type { ReactNode } from 'react';
import PageHeader, { type PageHeaderProps } from './PageHeader';

// 設定類頁面版型（MIL-181、ADR-0090）：頁首、提醒、由上而下依重要性排列的區段。
// 組織成員、執業主體、我的證書這類「幾個區段各管一件事」的頁面用它。
// 區段用 SettingsSection。只有一張表的頁面用 ListPage，不用這個版型。

export interface SettingsPageProps {
  header: PageHeaderProps;
  /** 區段上方的提醒，例如需要補件的說明。 */
  notices?: ReactNode;
  children: ReactNode;
}

export default function SettingsPage({ header, notices, children }: SettingsPageProps) {
  return (
    <Flex vertical gap="large">
      <PageHeader {...header} />
      {notices}
      {children}
    </Flex>
  );
}
