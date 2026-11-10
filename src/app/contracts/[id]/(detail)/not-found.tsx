import { Flex } from 'antd';
import EmptyState from '@/components/page/EmptyState';
import PageHeader from '@/components/page/PageHeader';

// 找不到合約時的畫面。格式錯誤的 ID、別的組織的 ID、不存在的 ID 與沒有查看權限，都是同一個畫面（P0-02 AC1）。
export default function ContractNotFound() {
  return (
    <Flex vertical gap="large">
      <PageHeader title="找不到合約" back={{ href: '/contracts', label: '返回合約列表' }} />
      <EmptyState description="這份合約不存在，或目前的身分不能查看。請回到合約列表選擇合約。" />
    </Flex>
  );
}
