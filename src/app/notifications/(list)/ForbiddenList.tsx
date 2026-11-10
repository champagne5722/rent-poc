import { Flex } from 'antd';
import EmptyState from '@/components/page/EmptyState';
import PageHeader from '@/components/page/PageHeader';

// 目前的身分沒有站內通知時的畫面（例如平台營運者）。頁首照舊，空狀態說明下一步。
export default function ForbiddenList() {
  return (
    <Flex vertical gap="large">
      <PageHeader title="通知列表" />
      <EmptyState description="目前的身分沒有站內通知。請從右上角切換到組織身分。" />
    </Flex>
  );
}
