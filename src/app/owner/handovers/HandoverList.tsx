'use client';

import { Alert, Button, Card, Empty, Flex, Table, Typography, type TableColumnsType } from 'antd';
import Link from 'next/link';
import { targetLabel } from '@/lib/handover/labels';
import type { HandoverListItem } from '@/lib/handover/service';
import { HandoverStateTag, SidesStatus } from './HandoverParts';
import styles from './handovers.module.css';

export interface LapsedMandatary {
  name: string;
  pendingUnits: number;
}

const OPEN = new Set(['draft', 'owner_confirmed', 'accepted', 'released']);

function Parties({ item }: { item: HandoverListItem }) {
  return (
    <Typography.Text type="secondary" className={styles.wrap}>
      {item.record.from.name} → {targetLabel(item.record.target)}
    </Typography.Text>
  );
}

const columns: TableColumnsType<HandoverListItem> = [
  {
    title: '租賃單位',
    key: 'unit',
    render: (_, item) => (
      <div className={styles.wrap}>
        <Typography.Text strong>{item.record.address}</Typography.Text>
        <div className={styles.compactMeta}>
          <Parties item={item} />
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
    title: '交出 → 接收',
    key: 'parties',
    responsive: ['md'],
    render: (_, item) => <Parties item={item} />,
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
      <Link href={`/owner/handovers/${item.record.id}`} style={{ whiteSpace: 'nowrap' }}>
        {item.record.state === 'draft' ? '檢查草稿' : '查看'}
      </Link>
    ),
  },
];

function Section({ title, items, empty }: { title: string; items: HandoverListItem[]; empty: string }) {
  return (
    <Card title={`${title}（${items.length}）`} styles={{ body: { padding: 0 } }}>
      <Table<HandoverListItem>
        size="middle"
        rowKey={(item) => item.record.id}
        columns={columns}
        dataSource={items}
        pagination={false}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={empty} /> }}
      />
    </Card>
  );
}

export default function HandoverList({
  items,
  lapsed,
  createdCount,
  canStart,
}: {
  items: HandoverListItem[];
  lapsed: LapsedMandatary[];
  createdCount: number | null;
  canStart: boolean;
}) {
  const open = items.filter((item) => OPEN.has(item.record.state));
  const completed = items.filter((item) => item.record.state === 'completed');
  const cancelled = items.filter((item) => item.record.state === 'cancelled');

  return (
    <Flex vertical gap={24 /* lg */}>
      <Flex justify="space-between" align="center" gap={12 /* sm */} wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          移交
        </Typography.Title>
        {/* TODO(MIL-108)：依 authorize() 的結果決定是否顯示「發起移交」 */}
        {canStart && (
          <Button type="primary" href="/owner/handovers/new">
            發起移交
          </Button>
        )}
      </Flex>

      {createdCount !== null && (
        <Alert
          type="success"
          showIcon
          title={
            createdCount > 0
              ? `已產生 ${createdCount} 份移交包草稿。請逐案檢查缺項，再確認移交。`
              : '這個委託管理案件的租賃單位都已有進行中的移交，沒有產生新草稿。'
          }
        />
      )}

      {lapsed.map((m) => (
        <Alert
          key={m.name}
          type="warning"
          showIcon
          title={`${m.name}的執業主體已失效`}
          description={`委託中還有 ${m.pendingUnits} 個租賃單位沒有移交。請發起移交，交給新受託人或改為自管。`}
        />
      ))}

      <Section title="進行中" items={open} empty="沒有進行中的移交" />
      <Section title="已完成" items={completed} empty="還沒有完成的移交" />
      {cancelled.length > 0 && <Section title="已取消" items={cancelled} empty="" />}
    </Flex>
  );
}
