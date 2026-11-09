'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button, Empty, Flex, Segmented, Table, Tag, Typography } from 'antd';
import Link from 'next/link';
import type { CaseSummary } from '@/lib/case-store';
import type { CaseState } from '@/lib/cases';
import { leasePeriodLabel, monthlyRentLabel } from '@/lib/case-display';
import { BUSINESS_TYPE_LABELS } from '@/lib/labels';
import { CASE_STATE_COLORS, CASE_STATE_LABELS } from '@/lib/labels/case-labels';
import { CONTRACT_STATUS_LABELS, type ContractStatus } from '@/lib/types';

// 案件清單（MIL-115，ADR-0023 決議 1）：目前組織主辦的案件，加上自己是成員的別組織案件。

type Row = CaseSummary & { isHost: boolean };

// 狀態分組：進行中的案件在前，結束的案件另一組
const GROUPS = {
  all: { label: '全部', states: null },
  draft: { label: '草稿', states: ['draft'] },
  signing: { label: '簽署中', states: ['signing'] },
  active: { label: '生效中', states: ['active', 'move_out', 'settling'] },
  ended: { label: '已結束', states: ['closed', 'aborted', 'terminated', 'expired'] },
} as const satisfies Record<string, { label: string; states: readonly CaseState[] | null }>;
type GroupKey = keyof typeof GROUPS;

function inGroup(row: Row, group: GroupKey): boolean {
  const states = GROUPS[group].states as readonly CaseState[] | null;
  return states === null || states.includes(row.state);
}

export default function CasesPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [group, setGroup] = useState<GroupKey>('all');

  useEffect(() => {
    void fetch('/api/cases')
      .then((res) => res.json())
      .then((json) => setRows(json.data ?? []))
      .finally(() => setLoading(false));
  }, []);

  const counts = useMemo(
    () => Object.fromEntries((Object.keys(GROUPS) as GroupKey[]).map((g) => [g, rows.filter((r) => inGroup(r, g)).length])) as Record<GroupKey, number>,
    [rows],
  );
  const visible = useMemo(() => rows.filter((r) => inGroup(r, group)), [rows, group]);

  return (
    <Flex vertical gap="large">
      <Typography.Title level={4} style={{ margin: 0 }}>
        案件
      </Typography.Title>

      <Segmented<GroupKey>
        value={group}
        onChange={setGroup}
        options={(Object.keys(GROUPS) as GroupKey[]).map((g) => ({ value: g, label: `${GROUPS[g].label} ${counts[g]}` }))}
      />

      <Table<Row>
        rowKey="id"
        size="middle"
        loading={loading}
        dataSource={visible}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={rows.length === 0 ? '還沒有案件。建立合約時會同時建立租賃案件。' : '此狀態下沒有案件'}
            >
              {rows.length === 0 && (
                <Link href="/contracts/new">
                  <Button type="primary">建立合約</Button>
                </Link>
              )}
            </Empty>
          ),
        }}
        columns={[
          {
            title: '案件',
            render: (_, r) => (
              <Link href={`/cases/${r.id}`}>{r.title || '（未命名案件）'}</Link>
            ),
          },
          {
            title: '業務類型',
            width: 100,
            render: (_, r) => (r.businessType ? BUSINESS_TYPE_LABELS[r.businessType] : '委託管理'),
          },
          {
            title: '狀態',
            width: 100,
            render: (_, r) => <Tag color={CASE_STATE_COLORS[r.state]}>{CASE_STATE_LABELS[r.state]}</Tag>,
          },
          { title: '承租人', render: (_, r) => r.lesseeNames ?? '—' },
          { title: '租期', width: 210, render: (_, r) => leasePeriodLabel(r.leaseStart, r.leaseEnd) },
          { title: '月租金', width: 110, align: 'right', render: (_, r) => monthlyRentLabel(r.monthlyRent) },
          {
            title: '目前合約',
            width: 110,
            render: (_, r) => (r.contractStatus ? CONTRACT_STATUS_LABELS[r.contractStatus as ContractStatus] : '—'),
          },
          {
            title: '主辦',
            width: 140,
            render: (_, r) => (r.isHost ? '本組織' : r.orgName),
          },
        ]}
      />
    </Flex>
  );
}
