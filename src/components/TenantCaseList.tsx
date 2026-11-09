'use client';

import { Empty, Flex, Tag, Typography, theme } from 'antd';
import Link from 'next/link';
import { leasePeriodLabel, monthlyRentLabel } from '@/lib/case-display';
import { CASE_STATE_COLORS, CASE_STATE_LABELS } from '@/lib/labels/case-labels';
import type { TenantCaseSummary } from '@/lib/tenant';
import { tenantContractStatusLabel } from '@/lib/tenant/labels';
import { TENANT_ROOT_HREF } from '@/lib/nav';

// 我的案件（MIL-121，P0-21 AC1）：承租人在所有組織的案件，新的在前。結案的案件仍列出。
// 沒有案件時只顯示「沒有案件」，不說明原因（P0-21 AC6）。

const CONTRACT_COLORS: Record<string, 'success' | 'processing' | 'default'> = {
  completed: 'success',
  awaiting_tenant: 'processing',
};

export default function TenantCaseList({ cases }: { cases: TenantCaseSummary[] }) {
  const { token } = theme.useToken();
  return (
    <Flex vertical gap="large">
      <Typography.Title level={4} style={{ margin: 0 }}>
        我的案件
      </Typography.Title>

      {cases.length === 0 ? (
        <Flex justify="center" style={{ paddingBlock: 48 /* xxl */ }}>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="沒有案件" />
        </Flex>
      ) : (
        // antd 6 的 List 已標示棄用，改用一般的列：容器有邊線，列與列之間用分隔線
        <Flex
          vertical
          role="list"
          aria-label="案件清單"
          style={{
            background: token.colorBgContainer,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: token.borderRadiusLG,
            overflow: 'hidden',
          }}
        >
          {cases.map((item, index) => (
            <Link
              key={item.id}
              role="listitem"
              href={`${TENANT_ROOT_HREF}/cases/${item.id}`}
              style={{
                display: 'block',
                minWidth: 0,
                padding: `${token.paddingMD}px ${token.paddingLG}px`,
                borderTop: index === 0 ? 'none' : `1px solid ${token.colorSplit}`,
              }}
            >
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
          ))}
        </Flex>
      )}
    </Flex>
  );
}
