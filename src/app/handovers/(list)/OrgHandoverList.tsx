'use client';

// 後台「移交」列表（MIL-98、MIL-182）：移交給我的案件與我交出的案件，各一張表。每列顯示兩側是否完成。
import { Button, Flex, Typography, type TableColumnsType } from 'antd';
import EmptyState from '@/components/page/EmptyState';
import ListTable from '@/components/page/ListTable';
import SettingsPage from '@/components/page/SettingsPage';
import SettingsSection from '@/components/page/SettingsSection';
import StatusTag from '@/components/StatusTag';
import { targetLabel } from '@/lib/handover/labels';
import type { HandoverListItem } from '@/lib/handover/service';
import { SidesStatus } from '../../owner/handovers/HandoverParts';
import styles from '../../owner/handovers/handovers.module.css';

type Side = 'incoming' | 'outgoing';

/** 另一方：移交給我的案件看交出方，我交出的案件看接收方。 */
const counterpart = (side: Side, item: HandoverListItem) =>
  side === 'incoming' ? item.record.from.name : targetLabel(item.record.target);

function actionLabel(side: Side, item: HandoverListItem): string {
  if (side === 'outgoing') return '查看唯讀副本';
  return item.record.state === 'owner_confirmed' ? '確認接手' : '查看';
}

function columns(side: Side): TableColumnsType<HandoverListItem> {
  const partyTitle = side === 'incoming' ? '交出方' : '接收方';
  return [
    {
      title: '租賃單位',
      key: 'unit',
      render: (_, item) => (
        <div className={styles.wrap}>
          <Typography.Text strong>{item.record.address}</Typography.Text>
          <div className={styles.compactMeta}>
            <Typography.Text type="secondary">
              {partyTitle}：{counterpart(side, item)}
            </Typography.Text>
            <Flex gap="small" wrap align="center">
              <StatusTag kind="handover" value={item.record.state} />
              {item.record.effectiveDate && (
                <Typography.Text type="secondary">生效日 {item.record.effectiveDate}</Typography.Text>
              )}
            </Flex>
            <SidesStatus sides={item.sides} />
          </div>
        </div>
      ),
    },
    {
      title: partyTitle,
      key: 'party',
      responsive: ['md'],
      render: (_, item) => (
        <Typography.Text type="secondary" className={styles.wrap}>
          {counterpart(side, item)}
        </Typography.Text>
      ),
    },
    {
      title: '狀態',
      key: 'state',
      responsive: ['md'],
      render: (_, item) => <StatusTag kind="handover" value={item.record.state} />,
    },
    {
      title: '兩側',
      key: 'sides',
      responsive: ['md'],
      render: (_, item) => <SidesStatus sides={item.sides} />,
    },
    {
      title: '生效日',
      key: 'effectiveDate',
      responsive: ['md'],
      align: 'right',
      render: (_, item) => item.record.effectiveDate ?? <Typography.Text type="secondary">未指定</Typography.Text>,
    },
    {
      title: '操作',
      key: 'action',
      align: 'right',
      render: (_, item) => (
        <Button type="link" size="small" href={`/handovers/${item.record.id}`} className={styles.nowrap}>
          {actionLabel(side, item)}
        </Button>
      ),
    },
  ];
}

function Section({
  side,
  title,
  items,
  empty,
}: {
  side: Side;
  title: string;
  items: HandoverListItem[];
  empty: string;
}) {
  return (
    <SettingsSection title={`${title}（${items.length}）`}>
      <ListTable<HandoverListItem>
        table={{ rowKey: (item) => item.record.id, columns: columns(side), dataSource: items }}
        emptyNode={<EmptyState description={empty} />}
      />
    </SettingsSection>
  );
}

export default function OrgHandoverList({
  orgName,
  incoming,
  outgoing,
}: {
  orgName: string;
  incoming: HandoverListItem[];
  outgoing: HandoverListItem[];
}) {
  const waiting = incoming.filter((item) => item.record.state === 'owner_confirmed').length;
  return (
    <SettingsPage
      header={{ title: '移交列表' }}
      notices={
        <Typography.Text type="secondary" className={styles.wrap}>
          {orgName}
          {waiting > 0 ? `。有 ${waiting} 個案件等你確認接手。` : ''}
        </Typography.Text>
      }
    >
      <Section side="incoming" title="移交給我的案件" items={incoming} empty="目前沒有移交給你的案件。屋主發起移交後，會列在這裡。" />
      <Section side="outgoing" title="我交出的案件" items={outgoing} empty="目前沒有你交出的案件。" />
    </SettingsPage>
  );
}
