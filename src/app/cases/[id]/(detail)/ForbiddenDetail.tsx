import { Flex } from 'antd';
import EmptyState from '@/components/page/EmptyState';
import PageHeader from '@/components/page/PageHeader';

// 目前的身分不能看案件時的畫面。頁首照舊，空狀態說明下一步。
export default function ForbiddenDetail() {
  return (
    <Flex vertical gap="large">
      <PageHeader title="案件詳情" back={{ href: '/cases', label: '返回案件列表' }} />
      <EmptyState description="目前的身分沒有查看案件的權限。請從右上角切換身分。" />
    </Flex>
  );
}
