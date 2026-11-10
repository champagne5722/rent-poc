'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Empty, Flex, Segmented, Table, Tag, Typography } from 'antd';
import Link from 'next/link';
import StatusTag from '@/components/StatusTag';
import { practitionerTitle, statutoryTitle, type LicenseKind } from '@/lib/labels';
import { claimedKeyText, formatWaiting, isBacklogged, queueTypeLabel, resolutionLabel } from '@/lib/practice-entities/display';
import type { QueueItem } from '@/lib/practice-entities/desk';

// 審核台佇列（MIL-109，GLOSSARY「審核台」）：平台營運者處理待核對項目。
// 待核對的最久的在前，附等待時間。等待超過 3 日標警示（ADR-0017 決議 12 的積壓門檻，假設）。
// 出租權源項目（MIL-201）：等待時間只算週一到週五，超過 1 個工作日標警示，兩項都相符卻停住的項目標「待處理」，核對畫面在 /desk/ownership/[id]。
// 只有平台營運者身分開得了，權限在 /api/desk/* 的 route 判斷，其他身分看到的是切換身分的提示。

type Status = 'open' | 'resolved';

function describeKinds(item: QueueItem): string {
  // 撞號項目（MIL-144）：宣稱的鍵。撞號超限項目顯示 24 小時內的上限與被擋次數
  if (item.summary.claimedKey) return claimedKeyText(item.summary.claimedKey, item.summary.claimedKeyNames);
  if (item.type === 'anchor_collision_limit') return `24 小時上限 ${item.summary.limit ?? '—'} 次，已被擋 ${item.summary.hits ?? '—'} 次`;
  if (item.summary.certificateKind) return practitionerTitle(item.summary.certificateKind);
  const kinds: LicenseKind[] = item.summary.kind ? [item.summary.kind] : (item.summary.kinds ?? []);
  return kinds.map((k) => statutoryTitle(k)).join('、') || '—';
}

/** 出租權源項目有自己的核對畫面，其餘項目走 /desk/items/[id]。 */
const reviewHref = (item: QueueItem): string => (item.type === 'leasing_authority' ? `/desk/ownership/${item.id}` : `/desk/items/${item.id}`);

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
          {
            title: '類型',
            dataIndex: 'type',
            width: 140,
            render: (type: string, item) =>
              item.summary.held ? (
                <Flex gap="small" align="center">
                  {queueTypeLabel(type)}
                  <StatusTag kind="ownershipItem" value="held" />
                </Flex>
              ) : (
                queueTypeLabel(type)
              ),
          },
          {
            title: '對象',
            key: 'entity',
            render: (_v, item) =>
              item.summary.claimantOrgName ? (
                // 撞號與撞號超限項目：宣稱方組織
                <Typography.Text>{item.summary.claimantOrgName}</Typography.Text>
              ) : item.summary.partyName ? (
                // 證書、任職、同意書項目：主要是人員，任職與同意書另列執業主體
                <Flex vertical>
                  <Typography.Text>{item.summary.partyName}</Typography.Text>
                  <Typography.Text type="secondary">{item.summary.entityName ?? ''}</Typography.Text>
                </Flex>
              ) : (
                <Flex vertical>
                  <Typography.Text>{item.summary.entityName ?? '—'}</Typography.Text>
                  <Typography.Text type="secondary">{item.summary.taxId ?? ''}</Typography.Text>
                </Flex>
              ),
          },
          { title: '業別、證書或鍵', key: 'kind', render: (_v, item) => describeKinds(item) },
          { title: '許可或登記證字號', key: 'permit', render: (_v, item) => item.summary.permitNo ?? '—' },
          status === 'open'
            ? {
                title: '等待時間',
                dataIndex: 'waitingMs',
                width: 200,
                align: 'right' as const,
                render: (ms: number, item) =>
                  item.type === 'leasing_authority' ? (
                    // 出租權源：只算工作日，目標是 1 個工作日內
                    <Flex gap="small" align="center" justify="flex-end">
                      {item.overdue && <StatusTag kind="ownershipItem" value="overdue" />}
                      <Typography.Text>{formatWaiting(item.waitingBusinessMs)}</Typography.Text>
                    </Flex>
                  ) : (
                    <Flex gap="small" align="center" justify="flex-end">
                      {isBacklogged(ms) && <Tag color="warning">超過 3 日</Tag>}
                      <Typography.Text>{formatWaiting(ms)}</Typography.Text>
                    </Flex>
                  ),
              }
            : { title: '結果', dataIndex: 'resolution', width: 140, render: resolutionLabel },
          { title: '操作', key: 'action', width: 90, render: (_v, item) => <Link href={reviewHref(item)}>{status === 'open' ? '核對' : '查看'}</Link> },
        ]}
      />
    </Flex>
  );
}
