'use client';

import { Flex, Skeleton } from 'antd';

// 列表頁的骨架畫面（MIL-174、ADR-0090）：頁首、篩選列、表格各用一塊 antd Skeleton，版面與 ListPage 對齊。
// 放進 Next.js 的 loading.tsx，資料載入時顯示，取代整頁轉圈。
// 標記為 client component：Skeleton.Input 這類 antd 的靜態成員在 server component 取不到；server component 仍然能渲染它。

const TABLE_ROWS = 8;

export interface ListPageSkeletonProps {
  /** 頁首右側有沒有主要動作。沒有時不畫動作的骨架，避免載入完成後版面位移。預設有。 */
  withAction?: boolean;
}

export default function ListPageSkeleton({ withAction = true }: ListPageSkeletonProps) {
  return (
    <Flex vertical gap="large" aria-busy="true" aria-label="載入中">
      <Flex justify="space-between" align="center" gap="middle">
        <Skeleton.Input active />
        {withAction && <Skeleton.Button active />}
      </Flex>
      <Skeleton.Input active block />
      <Skeleton active title={false} paragraph={{ rows: TABLE_ROWS }} />
    </Flex>
  );
}
