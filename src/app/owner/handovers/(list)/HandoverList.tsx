'use client';

import { Alert, Button, Flex, Typography, type TableColumnsType } from 'antd';
import EmptyState from '@/components/page/EmptyState';
import ListTable from '@/components/page/ListTable';
import SettingsPage from '@/components/page/SettingsPage';
import SettingsSection from '@/components/page/SettingsSection';
import StatusTag from '@/components/StatusTag';
import { targetLabel } from '@/lib/handover/labels';
import { isOpenHandover } from '@/lib/handover/transitions';
import type { HandoverListItem } from '@/lib/handover/service';
import { SidesStatus } from '../HandoverParts';
import styles from '../handovers.module.css';

// 屋主端移交列表（MIL-97、MIL-182）。移交分進行中、已完成、已取消三段，所以用設定類頁面版型加每段一張表。

export interface LapsedMandatary {
  name: string;
  pendingUnits: number;
}

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
    title: '交出 → 接收',
    key: 'parties',
    responsive: ['md'],
    render: (_, item) => <Parties item={item} />,
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
      <Button type="link" size="small" href={`/owner/handovers/${item.record.id}`} className={styles.nowrap}>
        {item.record.state === 'draft' ? '檢查草稿' : '查看'}
      </Button>
    ),
  },
];

function Section({ title, items, empty }: { title: string; items: HandoverListItem[]; empty: string }) {
  return (
    <SettingsSection title={`${title}（${items.length}）`}>
      <ListTable<HandoverListItem>
        table={{ rowKey: (item) => item.record.id, columns, dataSource: items }}
        emptyNode={<EmptyState description={empty} />}
      />
    </SettingsSection>
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
  const open = items.filter((item) => isOpenHandover(item.record.state));
  const completed = items.filter((item) => item.record.state === 'completed');
  const cancelled = items.filter((item) => item.record.state === 'cancelled');

  return (
    <SettingsPage
      header={{
        title: '移交列表',
        // TODO(MIL-108)：依 authorize() 的結果決定是否顯示「發起移交」
        extra: canStart && (
          <Button type="primary" href="/owner/handovers/new">
            發起移交
          </Button>
        ),
      }}
      notices={
        <>
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
        </>
      }
    >
      <Section title="進行中" items={open} empty="沒有進行中的移交。從委託管理案件發起移交。" />
      <Section title="已完成" items={completed} empty="還沒有完成的移交。" />
      {cancelled.length > 0 && <Section title="已取消" items={cancelled} empty="沒有已取消的移交。" />}
    </SettingsPage>
  );
}
