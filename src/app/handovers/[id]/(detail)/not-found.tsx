import { Flex } from 'antd';
import EmptyState from '@/components/page/EmptyState';
import PageHeader from '@/components/page/PageHeader';

// 找不到移交時的畫面。不存在的 ID 與別的組織的 ID 是同一個畫面。
export default function OrgHandoverNotFound() {
  return (
    <Flex vertical gap="large">
      <PageHeader title="找不到移交" back={{ href: '/handovers', label: '返回移交列表' }} />
      <EmptyState description="這個移交不存在，或目前的組織不能查看。請回到移交列表選擇移交。" />
    </Flex>
  );
}
