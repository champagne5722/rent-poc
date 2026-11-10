'use client';

import type { ReactNode } from 'react';
import { Card, Flex, Skeleton, Typography } from 'antd';
import styles from './AuthPanel.module.css';

// 登入頁的外框（MIL-183，ADR-0090）：畫布色底、卡片置中，卡片上方是產品名稱。
// 登入與第一次登入選身分共用，載入中的骨架畫面（AuthPanelSkeleton）也用同一個外框，載入完成後版面不位移。
// 標記為 client component：Skeleton 這類 antd 的靜態成員在 server component 取不到；server component 仍然能渲染它。

export const PRODUCT_NAME = '租房雲端管理平台';

export default function AuthPanel({ children }: { children: ReactNode }) {
  return (
    <main className={styles.page}>
      <div className={styles.panel}>
        <Typography.Text strong className={styles.brand}>
          {PRODUCT_NAME}
        </Typography.Text>
        <Card>{children}</Card>
      </div>
    </main>
  );
}

/** 登入頁載入中：標題、說明、輸入框、按鈕各一塊骨架，版面與 email 步驟對齊。 */
export function AuthPanelSkeleton() {
  return (
    <AuthPanel>
      <Flex vertical gap="large" aria-busy="true" aria-label="載入中">
        <Flex vertical gap="small">
          <Skeleton.Input active size="small" />
          <Skeleton.Input active size="small" block />
        </Flex>
        <Skeleton.Input active block />
        <Skeleton.Button active block />
      </Flex>
    </AuthPanel>
  );
}
