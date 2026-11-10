'use client';

import { Card, Flex, Typography } from 'antd';
import type { ReactNode } from 'react';

// 設定類頁面的區段（MIL-181、ADR-0090）：一張 Card size="small" 加標題，標題右側放該區段的動作，標題下方放說明。
// 只組合 antd 的 Card 與 Flex。卡片裡不再放卡片，表格直接放在區段內。

export interface SettingsSectionProps {
  title: string;
  /** 標題下方的一句說明，寫這個區段做什麼。 */
  description?: ReactNode;
  /** 標題右側的動作。 */
  extra?: ReactNode;
  children: ReactNode;
}

export default function SettingsSection({ title, description, extra, children }: SettingsSectionProps) {
  return (
    <Card size="small" title={title} extra={extra}>
      <Flex vertical gap="middle">
        {description && <Typography.Text type="secondary">{description}</Typography.Text>}
        {children}
      </Flex>
    </Card>
  );
}
