import { Flex } from 'antd';
import EmptyState from './EmptyState';
import PageHeader from './PageHeader';

// 目前的身分看不到這一頁時的畫面（MIL-181）：頁首照舊，空狀態說明下一步，沒有動作。
export default function NoAccess({ title, description }: { title: string; description: string }) {
  return (
    <Flex vertical gap="large">
      <PageHeader title={title} />
      <EmptyState description={description} />
    </Flex>
  );
}
