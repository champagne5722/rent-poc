'use client';

import { Button, Flex } from 'antd';
import EmptyState from '@/components/page/EmptyState';
import PageHeader from '@/components/page/PageHeader';

// 出租權源核對載入失敗時的畫面（MIL-201）。說明下一步：重新載入，仍然失敗時回審核台。
export default function OwnershipReviewError({ unstable_retry }: { error: Error & { digest?: string }; unstable_retry: () => void }) {
  return (
    <Flex vertical gap="large">
      <PageHeader title="出租權源核對" back={{ href: '/desk', label: '返回審核台' }} />
      <EmptyState
        description="審核項目載入失敗。請按「重新載入」，仍然失敗時請回審核台，稍後再開啟這個項目。"
        action={<Button onClick={() => unstable_retry()}>重新載入</Button>}
      />
    </Flex>
  );
}
