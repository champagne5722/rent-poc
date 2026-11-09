'use client';

import { Empty, Flex, Table, Tag, Typography } from 'antd';
import Link from 'next/link';
import { leasePeriodLabel, monthlyRentLabel } from '@/lib/case-display';
import { CASE_STATE_COLORS, CASE_STATE_LABELS } from '@/lib/labels/case-labels';
import type { TenantCaseSummary } from '@/lib/tenant';
import { tenantContractStatusLabel } from '@/lib/tenant/labels';
import { TENANT_ROOT_HREF } from '@/lib/nav';

// 我的案件（MIL-121，P0-21 AC1）：承租人在所有組織的案件，新的在前。結案的案件仍列出。
// 沒有案件時只顯示「沒有案件」，不說明原因（P0-21 AC6）。
// 可互動列表用 Table（DESIGN.md「Components」）。手機寬度放不下多欄，所以只有一欄：欄內堆疊標題、組織、狀態與租期，
// 整格是連結，表頭不顯示。這樣 375px 不需要水平捲動。

const CONTRACT_COLORS: Record<string, 'success' | 'processing' | 'default'> = {
  completed: 'success',
  awaiting_tenant: 'processing',
};

export default function TenantCaseList({ cases }: { cases: TenantCaseSummary[] }) {
  return (
    <Flex vertical gap="large">
      <Typography.Title level={4} style={{ margin: 0 }}>
        我的案件
      </Typography.Title>

      <Table<TenantCaseSummary>
        rowKey="id"
        size="middle"
        showHeader={false}
        pagination={false}
        dataSource={cases}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="沒有案件" /> }}
        columns={[
          {
            key: 'case',
            render: (_, item) => (
              <Link href={`${TENANT_ROOT_HREF}/cases/${item.id}`} style={{ display: 'block', minWidth: 0 }}>
                <Flex vertical gap={4}>
                  <Typography.Text strong>{item.title || '（未命名案件）'}</Typography.Text>
                  <Typography.Text type="secondary">{item.orgName}</Typography.Text>
                  <Flex wrap gap={8} align="center">
                    <Tag color={CASE_STATE_COLORS[item.state]} style={{ marginInlineEnd: 0 }}>
                      {CASE_STATE_LABELS[item.state]}
                    </Tag>
                    {item.contractStatus !== null && (
                      <Tag color={CONTRACT_COLORS[item.contractStatus] ?? 'default'} style={{ marginInlineEnd: 0 }}>
                        合約：{tenantContractStatusLabel(item.contractStatus)}
                      </Tag>
                    )}
                  </Flex>
                  <Typography.Text type="secondary">
                    {leasePeriodLabel(item.leaseStart, item.leaseEnd)}，月租金 {monthlyRentLabel(item.monthlyRent)}
                  </Typography.Text>
                </Flex>
              </Link>
            ),
          },
        ]}
      />
    </Flex>
  );
}
