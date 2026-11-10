'use client';

import { useState } from 'react';
import { Flex, Typography, type TableColumnsType } from 'antd';
import Link from 'next/link';
import ListPage from '@/components/page/ListPage';
import StatusTag from '@/components/StatusTag';
import { practitionerTitle, statutoryTitle, type LicenseKind } from '@/lib/labels';
import { ownershipItemStatus } from '@/lib/ownership/review-status';
import { claimedKeyText, formatWaiting, isBacklogged, queueTypeLabel, resolutionLabel } from '@/lib/practice-entities/display';
import type { QueueItem } from '@/lib/practice-entities/desk';

// 審核台佇列（MIL-109、MIL-180，GLOSSARY「審核台」）：平台營運者處理待核對項目。列表頁版型，資料由 server component 載入。
// 待核對的最久的在前，附等待時間與狀態標籤。非出租權源項目等待超過 3 日標警示（ADR-0017 決議 12 的積壓門檻，假設）。
// 出租權源項目（MIL-201）：等待時間只算週一到週五，超過 1 個工作日標警示，兩項都相符卻停住的項目標「待處理」，核對畫面在 /desk/ownership/[id]。
// 只有平台營運者身分開得了。權限在 server component 與 /api/desk/* 的 route 判斷，其他身分看到的是切換身分的提示。

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

/** 狀態欄：出租權源項目有自己的狀態（待處理、超過 1 個工作日），其餘項目只有待核對與已結案。 */
function statusOf(item: QueueItem) {
  return item.type === 'leasing_authority' ? (
    <StatusTag kind="ownershipItem" value={ownershipItemStatus({ status: item.status, resolution: item.resolution, overdue: item.overdue, held: item.summary.held === true })} />
  ) : (
    <StatusTag kind="reviewItem" value={item.status} />
  );
}

/** 等待時間：出租權源只算工作日，其餘項目算日曆日。超過門檻時用警示色。 */
function waitingOf(item: QueueItem) {
  if (item.type === 'leasing_authority') return <Typography.Text type={item.overdue ? 'warning' : undefined}>{formatWaiting(item.waitingBusinessMs)}</Typography.Text>;
  const backlogged = isBacklogged(item.waitingMs);
  return <Typography.Text type={backlogged ? 'warning' : undefined}>{backlogged ? `${formatWaiting(item.waitingMs)}（超過 3 日）` : formatWaiting(item.waitingMs)}</Typography.Text>;
}

const COLUMNS: TableColumnsType<QueueItem> = [
  {
    title: '類型',
    dataIndex: 'type',
    width: 120,
    render: (type: string) => queueTypeLabel(type),
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
  { title: '狀態', key: 'status', width: 150, render: (_v, item) => statusOf(item) },
];

const OPEN_COLUMNS: TableColumnsType<QueueItem> = [
  ...COLUMNS,
  { title: '等待時間', dataIndex: 'waitingMs', width: 160, align: 'right', render: (_ms: number, item) => waitingOf(item) },
  actionColumn('核對'),
];

const RESOLVED_COLUMNS: TableColumnsType<QueueItem> = [
  ...COLUMNS,
  { title: '結果', dataIndex: 'resolution', width: 120, render: resolutionLabel },
  actionColumn('查看'),
];

/** 操作欄放最右並固定，用文字連結（列表頁版型的規則）。 */
function actionColumn(label: string): TableColumnsType<QueueItem>[number] {
  return {
    title: '操作',
    key: 'action',
    width: 80,
    fixed: 'right',
    render: (_v, item) => <Link href={reviewHref(item)}>{label}</Link>,
  };
}

export default function DeskQueue({ open, resolved }: { open: QueueItem[]; resolved: QueueItem[] }) {
  const [status, setStatus] = useState<Status>('open');

  return (
    <ListPage<QueueItem, Status>
      header={{ title: '審核項目列表' }}
      filter={{
        status: {
          value: status,
          onChange: setStatus,
          options: [
            { value: 'open', label: '待核對', count: open.length },
            { value: 'resolved', label: '已結案', count: resolved.length },
          ],
        },
        active: false,
        onClear: () => setStatus('open'),
      }}
      empty={{ description: status === 'open' ? '沒有待核對的項目。有新的送件時，項目會出現在這裡。' : '還沒有結案的項目。判定送出後，項目會移到這裡。' }}
      table={{
        rowKey: 'id',
        dataSource: status === 'open' ? open : resolved,
        columns: status === 'open' ? OPEN_COLUMNS : RESOLVED_COLUMNS,
        scroll: { x: 'max-content' },
      }}
    />
  );
}
