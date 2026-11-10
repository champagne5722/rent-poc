import { Flex } from 'antd';
import EmptyState from '@/components/page/EmptyState';
import PageHeader from '@/components/page/PageHeader';

// 找不到案件時的畫面。格式錯誤的 ID、別的組織的 ID、不存在的 ID 與不是成員，都是同一個畫面（P0-02 AC1）。
export default function CaseNotFound() {
  return (
    <Flex vertical gap="large">
      <PageHeader title="找不到案件" back={{ href: '/cases', label: '返回案件列表' }} />
      <EmptyState description="這個案件不存在，或你不是這個案件的成員。請回到案件列表選擇案件。" />
    </Flex>
  );
}
