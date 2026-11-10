import { Flex } from 'antd';
import EmptyState from '@/components/page/EmptyState';
import PageHeader from '@/components/page/PageHeader';

// 屋主端找不到案件時的畫面。不存在與不是成員是同一個畫面（P0-02 AC1）。
export default function OwnerCaseNotFound() {
  return (
    <Flex vertical gap="large">
      <PageHeader title="找不到案件" back={{ href: '/owner', label: '返回資產總覽' }} />
      <EmptyState description="這個案件不存在，或你不是這個案件的成員。請回到資產總覽選擇案件。" />
    </Flex>
  );
}
