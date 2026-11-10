'use client';

import { useMemo, useState } from 'react';
import { Button } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import Link from 'next/link';
import ListPage from '@/components/page/ListPage';
import StatusTag from '@/components/StatusTag';
import { caseKindLabel, leasePeriodLabel, monthlyRentLabel } from '@/lib/case-display';
import type { CaseListRow } from '@/lib/case-list-load';
import type { CaseState } from '@/lib/cases';
import type { ContractStatus } from '@/lib/types';

// 案件列表（MIL-115、MIL-184）：套用列表頁版型。資料由 server component 載入後傳進來，這裡只管狀態分組與欄位。
// 目前組織主辦的案件，加上自己是成員的別組織案件。

// 狀態分組：進行中的案件在前，結束的案件另一組
const GROUPS = {
  all: { label: '全部', states: null },
  draft: { label: '草稿', states: ['draft'] },
  signing: { label: '簽署中', states: ['signing'] },
  active: { label: '生效中', states: ['active', 'move_out', 'settling'] },
  ended: { label: '已結束', states: ['closed', 'aborted', 'terminated', 'expired'] },
} as const satisfies Record<string, { label: string; states: readonly CaseState[] | null }>;
type GroupKey = keyof typeof GROUPS;
const GROUP_KEYS = Object.keys(GROUPS) as GroupKey[];

function inGroup(row: CaseListRow, group: GroupKey): boolean {
  const states = GROUPS[group].states as readonly CaseState[] | null;
  return states === null || states.includes(row.state);
}

export default function CaseList({ rows }: { rows: CaseListRow[] }) {
  const [group, setGroup] = useState<GroupKey>('all');

  const counts = useMemo(
    () => Object.fromEntries(GROUP_KEYS.map((g) => [g, rows.filter((r) => inGroup(r, g)).length])) as Record<GroupKey, number>,
    [rows],
  );
  const visible = useMemo(() => rows.filter((r) => inGroup(r, group)), [rows, group]);

  return (
    <ListPage<CaseListRow, GroupKey>
      header={{ title: '案件列表' }}
      filter={{
        status: {
          value: group,
          onChange: setGroup,
          options: GROUP_KEYS.map((g) => ({ value: g, label: GROUPS[g].label, count: counts[g] })),
        },
        active: group !== 'all',
        onClear: () => setGroup('all'),
      }}
      empty={{
        description: '還沒有案件。建立合約時會同時建立租賃案件。',
        action: (
          <Link href="/contracts/new">
            <Button type="primary" icon={<PlusOutlined />}>
              建立合約
            </Button>
          </Link>
        ),
      }}
      table={{
        rowKey: 'id',
        dataSource: visible,
        scroll: { x: 1000 },
        columns: [
          { title: '案件', render: (_, r) => <Link href={`/cases/${r.id}`}>{r.title || '（未命名案件）'}</Link> },
          { title: '案件種類', width: 120, render: (_, r) => caseKindLabel(r.caseKind, r.businessType) },
          { title: '狀態', width: 96, render: (_, r) => <StatusTag kind="case" value={r.state} /> },
          { title: '承租人', render: (_, r) => r.lesseeNames ?? '—' },
          { title: '租期', width: 200, render: (_, r) => leasePeriodLabel(r.leaseStart, r.leaseEnd) },
          { title: '月租金', width: 100, align: 'right', render: (_, r) => monthlyRentLabel(r.monthlyRent) },
          {
            title: '目前合約',
            width: 108,
            render: (_, r) => (r.contractStatus ? <StatusTag kind="contract" value={r.contractStatus as ContractStatus} /> : '—'),
          },
          { title: '主辦', width: 130, render: (_, r) => (r.isHost ? '本組織' : r.orgName) },
        ],
      }}
    />
  );
}
