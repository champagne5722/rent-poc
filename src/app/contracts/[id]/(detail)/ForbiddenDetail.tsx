import { Flex } from 'antd';
import EmptyState from '@/components/page/EmptyState';
import PageHeader from '@/components/page/PageHeader';

// 目前的身分不能看合約時的畫面（例如承租人或平台營運者）。頁首照舊，空狀態說明下一步。
export default function ForbiddenDetail() {
  return (
    <Flex vertical gap="large">
      <PageHeader title="合約詳情" back={{ href: '/contracts', label: '返回合約列表' }} />
      <EmptyState description="目前的身分沒有查看合約的權限。請從右上角切換身分。" />
    </Flex>
  );
}
