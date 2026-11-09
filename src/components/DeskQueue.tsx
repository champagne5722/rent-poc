'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Empty, Flex, Segmented, Table, Tag, Typography } from 'antd';
import Link from 'next/link';
import { statutoryTitle, type LicenseKind } from '@/lib/labels';
import { formatWaiting, isBacklogged, queueTypeLabel, resolutionLabel } from '@/lib/practice-entities/display';
import type { QueueItem } from '@/lib/practice-entities/desk';

// 審核台佇列（MIL-109，GLOSSARY「審核台」）：平台營運者處理待核對項目。
// 待核對的最久的在前，附等待時間。等待超過 3 日標警示（ADR-0017 決議 12 的積壓門檻，假設）。
// 只有平台營運者身分開得了，權限在 /api/desk/* 的 route 判斷，其他身分看到的是切換身分的提示。

type Status = 'open' | 'resolved';

function describeKinds(item: QueueItem): string {
  const kinds: LicenseKind[] = item.summary.kind ? [item.summary.kind] : (item.summary.kinds ?? []);
  return kinds.map((k) => statutoryTitle(k)).join('、') || '—';
}

export default function DeskQueue() {
  const [status, setStatus] = useState<Status>('open');
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (next: Status): Promise<{ items: QueueItem[] } | { error: string }> => {
    try {
      const response = await fetch(`/api/desk/queue?status=${next}`);
      if (response.status === 403) return { error: '只有平台營運者身分能開啟審核台。請從右上角切換身分。' };
      if (!response.ok) throw new Error(String(response.status));
      return { items: ((await response.json()) as { data: { items: QueueItem[] } }).data.items };
    } catch {
      return { error: '審核台載入失敗，請重新整理。' };
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void load(status).then((result) => {
      if (cancelled) return;
      if ('items' in result) {
        setItems(result.items);
        setError(null);
      } else {
        setError(result.error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [load, status]);

  if (error) return <Alert type="error" showIcon title={error} />;

  return (
    <Flex vertical gap="middle" style={{ maxWidth: 1080 }}>
      <Flex align="center" justify="space-between" wrap gap="small">
        <Typography.Title level={5} style={{ margin: 0 }}>
          {status === 'open' ? '待核對項目' : '已結案項目'}
        </Typography.Title>
        <Segmented<Status>
          value={status}
          onChange={(next) => {
            setItems(null);
            setStatus(next);
          }}
          options={[
            { value: 'open', label: '待核對' },
            { value: 'resolved', label: '已結案' },
          ]}
        />
      </Flex>
      <Table<QueueItem>
        size="middle"
        rowKey="id"
        loading={items === null}
        pagination={false}
        dataSource={items ?? []}
        locale={{ emptyText: <Empty description={status === 'open' ? '沒有待核對的項目。' : '還沒有結案的項目。'} /> }}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: '類型', dataIndex: 'type', width: 110, render: queueTypeLabel },
          {
            title: '執業主體',
            key: 'entity',
            render: (_v, item) => (
              <Flex vertical>
                <Typography.Text>{item.summary.entityName ?? '—'}</Typography.Text>
                <Typography.Text type="secondary">{item.summary.taxId ?? ''}</Typography.Text>
              </Flex>
            ),
          },
          { title: '業別', key: 'kind', render: (_v, item) => describeKinds(item) },
          { title: '許可或登記證字號', key: 'permit', render: (_v, item) => item.summary.permitNo ?? '—' },
          status === 'open'
            ? {
                title: '等待時間',
                dataIndex: 'waitingMs',
                width: 140,
                align: 'right' as const,
                render: (ms: number) => (
                  <Flex gap="small" align="center" justify="flex-end">
                    {isBacklogged(ms) && <Tag color="warning">超過 3 日</Tag>}
                    <Typography.Text>{formatWaiting(ms)}</Typography.Text>
                  </Flex>
                ),
              }
            : { title: '結果', dataIndex: 'resolution', width: 140, render: resolutionLabel },
          { title: '操作', key: 'action', width: 90, render: (_v, item) => <Link href={`/desk/items/${item.id}`}>{status === 'open' ? '核對' : '查看'}</Link> },
        ]}
      />
    </Flex>
  );
}
