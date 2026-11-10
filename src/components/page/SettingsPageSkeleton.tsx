'use client';

import { Card, Flex, Skeleton } from 'antd';

// 設定類頁面的骨架畫面（MIL-181、ADR-0090）：頁首加兩個區段，版面與 SettingsPage 對齊。
// 放進 Next.js 的 loading.tsx，資料載入時顯示，取代整頁轉圈。

export interface SettingsPageSkeletonProps {
  /** 頁首右側有沒有動作。預設沒有。 */
  withAction?: boolean;
}

export default function SettingsPageSkeleton({ withAction = false }: SettingsPageSkeletonProps) {
  return (
    <Flex vertical gap="large" aria-busy="true" aria-label="載入中">
      <Flex justify="space-between" align="center" gap="middle">
        <Skeleton.Input active />
        {withAction && <Skeleton.Button active />}
      </Flex>
      {[0, 1].map((key) => (
        <Card key={key} size="small">
          <Skeleton active paragraph={{ rows: 4 }} />
        </Card>
      ))}
    </Flex>
  );
}
