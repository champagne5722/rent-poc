import { Flex } from 'antd';
import EmptyState from '@/components/page/EmptyState';
import PageHeader from '@/components/page/PageHeader';

// 找不到出租權源項目時的畫面。格式錯誤的 ID 與不存在的項目，是同一個畫面（MIL-201）。
export default function OwnershipReviewNotFound() {
  return (
    <Flex vertical gap="large">
      <PageHeader title="找不到審核項目" back={{ href: '/desk', label: '返回審核台' }} />
      <EmptyState description="這個審核項目不存在。請回審核台，從佇列選擇項目。" />
    </Flex>
  );
}
