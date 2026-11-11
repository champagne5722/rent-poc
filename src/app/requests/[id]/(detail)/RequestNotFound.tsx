import { Flex } from 'antd';
import EmptyState from '@/components/page/EmptyState';
import PageHeader from '@/components/page/PageHeader';
import { REQUEST_NOT_FOUND_MESSAGE } from '@/lib/mandate-requests/messages';

// 找不到申請時的畫面。不存在、別的組織的、ID 格式不合，都是同一個畫面。
export default function RequestNotFound() {
  return (
    <Flex vertical gap="large">
      <PageHeader title={REQUEST_NOT_FOUND_MESSAGE} back={{ href: '/requests', label: '返回申請列表' }} />
      <EmptyState description="這份申請不存在，或目前的身分不能查看。請回到申請列表選擇申請。" />
    </Flex>
  );
}
