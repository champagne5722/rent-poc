'use client';

import { Card, Col, Flex, Row, Skeleton } from 'antd';

// 詳情頁的骨架畫面（MIL-175、ADR-0090）：返回連結、頁首、「下一步」區塊、主要內容與屬性側欄各用一塊 antd Skeleton，版面與 DetailPage 對齊。
// 放進 Next.js 的 loading.tsx，資料載入時顯示，取代整頁轉圈。
// 標記為 client component：Skeleton.Input 這類 antd 的靜態成員在 server component 取不到；server component 仍然能渲染它。

export interface DetailPageSkeletonProps {
  /** 頁首右側有沒有動作。沒有時不畫動作的骨架，避免載入完成後版面位移。預設有。 */
  withAction?: boolean;
}

export default function DetailPageSkeleton({ withAction = true }: DetailPageSkeletonProps) {
  return (
    <Flex vertical gap="large" aria-busy="true" aria-label="載入中">
      <Flex vertical gap="small">
        <Skeleton.Input active size="small" />
        <Flex justify="space-between" align="center" gap="middle">
          <Skeleton.Input active />
          {withAction && <Skeleton.Button active />}
        </Flex>
      </Flex>
      <Card size="small">
        <Skeleton active title={false} paragraph={{ rows: 3 }} />
      </Card>
      <Row gutter={[24, 24]}>
        <Col xs={24} xl={16}>
          <Flex vertical gap="large">
            <Card size="small">
              <Skeleton active paragraph={{ rows: 2 }} />
            </Card>
            <Card size="small">
              <Skeleton active paragraph={{ rows: 6 }} />
            </Card>
          </Flex>
        </Col>
        <Col xs={24} xl={8}>
          <Card size="small">
            <Skeleton active title={false} paragraph={{ rows: 8 }} />
          </Card>
        </Col>
      </Row>
    </Flex>
  );
}
