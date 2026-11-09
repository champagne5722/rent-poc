'use client';

import { Alert, Button, Descriptions, Flex, Tabs, Tag, Typography } from 'antd';
import type { TabsProps } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import Link from 'next/link';
import { TERMINAL_CASE_STATES } from '@/lib/access';
import { leasePeriodLabel, monthlyRentLabel } from '@/lib/case-display';
import { BUSINESS_TYPE_LABELS } from '@/lib/labels';
import { CASE_MEMBER_RELATION_LABELS, CASE_STATE_COLORS, CASE_STATE_LABELS } from '@/lib/labels/case-labels';
import { TENANT_ROOT_HREF } from '@/lib/nav';
import type { TenantCaseDetail } from '@/lib/tenant';
import { tenantContractStatusLabel } from '@/lib/tenant/labels';

// 承租人端的案件詳情（MIL-121，P0-21）。分頁呈現（DESIGN.md「Layout」）：第一頁「概況」有合約與案件資訊。
//
// 給 E 線：押金台帳、點交、報修用 extraTabs 加分頁，每個分頁一個 { key, label, children }。
// 結案後唯讀（P0-09 AC6）：readOnly 在這裡依案件狀態算好，分頁內容若有寫入入口，請接 readOnly 隱藏。
// 這張票只有讀取，所以目前沒有任何寫入入口，唯讀只影響提示文字。

export default function TenantCaseView({
  detail,
  extraTabs = [],
}: {
  detail: TenantCaseDetail;
  extraTabs?: TabsProps['items'];
}) {
  const readOnly = TERMINAL_CASE_STATES.includes(detail.state);
  const downloadHref = `/api/tenant/cases/${detail.id}/signed-pdf`;

  return (
    <Flex vertical gap="large">
      <Flex vertical gap={8}>
        <Link href={TENANT_ROOT_HREF}>回到我的案件</Link>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {detail.title || '（未命名案件）'}
        </Typography.Title>
        <Flex wrap gap={8} align="center">
          <Tag color={CASE_STATE_COLORS[detail.state]} style={{ marginInlineEnd: 0 }}>
            {CASE_STATE_LABELS[detail.state]}
          </Tag>
          {readOnly && <Tag style={{ marginInlineEnd: 0 }}>唯讀</Tag>}
        </Flex>
      </Flex>

      {readOnly && <Alert type="info" showIcon title="這個案件已結束，只能查看與下載。" />}

      <Tabs
        items={[
          {
            key: 'overview',
            label: '概況',
            children: (
              <Flex vertical gap="large">
                <Flex vertical gap={12}>
                  <Typography.Title level={5} style={{ margin: 0 }}>
                    合約
                  </Typography.Title>
                  <Descriptions
                    column={1}
                    size="small"
                    bordered
                    items={[
                      {
                        key: 'status',
                        label: '合約狀態',
                        children: tenantContractStatusLabel(detail.contract?.status ?? null),
                      },
                      {
                        key: 'signed',
                        label: '已簽合約',
                        children: <SignedContract detail={detail} href={downloadHref} />,
                      },
                    ]}
                  />
                </Flex>

                <Flex vertical gap={12}>
                  <Typography.Title level={5} style={{ margin: 0 }}>
                    案件資訊
                  </Typography.Title>
                  <Descriptions
                    column={1}
                    size="small"
                    bordered
                    items={[
                      {
                        key: 'lessor',
                        label: CASE_MEMBER_RELATION_LABELS.lessor,
                        children: detail.lessorNames.length > 0 ? detail.lessorNames.join('、') : detail.orgName,
                      },
                      ...(detail.businessType === 'managed'
                        ? [{ key: 'org', label: '代管業者', children: detail.orgName }]
                        : []),
                      {
                        key: 'type',
                        label: '業務類型',
                        children: detail.businessType ? BUSINESS_TYPE_LABELS[detail.businessType] : '—',
                      },
                      { key: 'period', label: '租期', children: leasePeriodLabel(detail.leaseStart, detail.leaseEnd) },
                      { key: 'rent', label: '月租金', children: monthlyRentLabel(detail.monthlyRent) },
                      { key: 'relation', label: '你在案件中的關係', children: CASE_MEMBER_RELATION_LABELS[detail.relation] },
                    ]}
                  />
                </Flex>
              </Flex>
            ),
          },
          ...extraTabs,
        ]}
      />
    </Flex>
  );
}

function SignedContract({ detail, href }: { detail: TenantCaseDetail; href: string }) {
  if (detail.contract?.hasSignedPdf) {
    return (
      <Button type="primary" icon={<DownloadOutlined />} href={href}>
        下載已簽合約
      </Button>
    );
  }
  if (detail.contract?.status === 'completed') {
    return <Typography.Text type="secondary">暫時無法下載，請聯絡出租人。</Typography.Text>;
  }
  return <Typography.Text type="secondary">合約簽署完成後，可以在這裡下載。</Typography.Text>;
}
