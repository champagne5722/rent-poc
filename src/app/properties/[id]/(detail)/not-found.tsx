import { Flex } from 'antd';
import EmptyState from '@/components/page/EmptyState';
import PageHeader from '@/components/page/PageHeader';

// 找不到物件時的畫面。格式錯誤的 ID、別的組織的 ID、不存在的 ID 與沒有查看權限，都是同一個畫面（P0-02 AC1）。
export default function PropertyNotFound() {
  return (
    <Flex vertical gap="large">
      <PageHeader title="找不到物件" back={{ href: '/properties', label: '返回物件列表' }} />
      <EmptyState description="這個物件不存在，或目前的身分不能查看。請回到物件列表選擇物件。" />
    </Flex>
  );
}
