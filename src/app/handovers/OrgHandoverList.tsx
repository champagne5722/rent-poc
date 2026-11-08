'use client';

// 後台「移交」清單（MIL-98）：移交給我的案件與我交出的案件。每列顯示兩側是否完成。
import { Card, Empty, Flex, Table, Typography, type TableColumnsType } from 'antd';
import Link from 'next/link';
import { targetLabel } from '@/lib/handover/labels';
import type { HandoverListItem } from '@/lib/handover/service';
import { HandoverStateTag, SidesStatus } from '../owner/handovers/HandoverParts';
import styles from '../owner/handovers/handovers.module.css';

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
            <Flex gap={8 /* xs */} wrap align="center">
              <HandoverStateTag state={item.record.state} />
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
      render: (_, item) => <HandoverStateTag state={item.record.state} />,
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
        <Link href={`/handovers/${item.record.id}`} style={{ whiteSpace: 'nowrap' }}>
          {actionLabel(side, item)}
        </Link>
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
    <Card title={`${title}（${items.length}）`} styles={{ body: { padding: 0 } }}>
      <Table<HandoverListItem>
        size="middle"
        rowKey={(item) => item.record.id}
        columns={columns(side)}
        dataSource={items}
        pagination={false}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={empty} /> }}
      />
    </Card>
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
    <Flex vertical gap={24 /* lg */}>
      <Flex vertical gap={4 /* xxs */} className={styles.wrap}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          移交
        </Typography.Title>
        <Typography.Text type="secondary">
          {orgName}
          {waiting > 0 ? `。有 ${waiting} 個案件等你確認接手。` : ''}
        </Typography.Text>
      </Flex>
      <Section side="incoming" title="移交給我的案件" items={incoming} empty="目前沒有移交給你的案件" />
      <Section side="outgoing" title="我交出的案件" items={outgoing} empty="目前沒有你交出的案件" />
    </Flex>
  );
}
