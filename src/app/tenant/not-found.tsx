'use client';

import { Button, Empty, Flex } from 'antd';
import { TENANT_ROOT_HREF } from '@/lib/nav';

// 承租人端的 404。別人的案件與不存在的案件都停在這裡，畫面相同（P0-09 AC1），不說明原因。
export default function TenantNotFound() {
  return (
    <Flex justify="center" style={{ paddingBlock: 48 /* xxl */ }}>
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="找不到這個頁面">
        <Button href={TENANT_ROOT_HREF}>回到我的案件</Button>
      </Empty>
    </Flex>
  );
}
