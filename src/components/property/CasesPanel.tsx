'use client';

// 物件詳情的「案件」區（MIL-177、MIL-209，ADR-0030 決議 5）：看得出兩層。
// 委託管理案件與底下的租賃案件，或包租案件與底下的轉租案件。上層案件不在這個物件的案件裡時，上層列只有種類與連結。
// 建立案件的入口在卡片右上角（MIL-209、MIL-205）：只在伺服端算出的 availableCaseKinds 不是空的時候出現。
// 物件沒通過核對時沒有入口，原因寫在頁面上方「下一步」。

import { Card, Table, Typography } from 'antd';
import Link from 'next/link';
import EmptyState from '@/components/page/EmptyState';
import CreateCaseEntry from '@/components/property/CreateCaseEntry';
import StatusTag from '@/components/StatusTag';
import { leasePeriodLabel, monthlyRentLabel } from '@/lib/case-display';
import type { CaseSummary } from '@/lib/case-store';
import { buildCaseLayers, casesEmptyText } from '@/lib/property-case-layers';
import { statusPresentation } from '@/lib/status-presentation';
import type { PropertyCaseKind } from '@/lib/types';

interface CaseRow {
  key: string;
  /** 有案件資料時才有。只有上層 ID 的列沒有。 */
  summary: CaseSummary | null;
  /** 只有上層 ID 的列：案件種類與連結。 */
  placeholder?: { id: string; kind: 'management' | 'master_lease' };
  children?: CaseRow[];
}

const toRow = (summary: CaseSummary, children?: CaseRow[]): CaseRow => ({ key: summary.id, summary, ...(children?.length ? { children } : {}) });

function buildRows(cases: CaseSummary[]): CaseRow[] {
  return buildCaseLayers(cases).map((layer) => {
    const kids = layer.children.map((child) => toRow(child));
    if (layer.parent) return toRow(layer.parent, kids);
    return {
      key: `parent:${layer.parentId}`,
      summary: null,
      placeholder: { id: layer.parentId, kind: layer.parentKind === 'management' ? 'management' : 'master_lease' },
      children: kids,
    } satisfies CaseRow;
  });
}

interface CasesPanelProps {
  cases: CaseSummary[];
  verified: boolean;
  /** 這個物件（租賃單位）的 ID，建立案件的入口用。 */
  propertyId: string;
  /** 目前組織能建立的案件種類。空陣列時不畫入口。 */
  availableCaseKinds: readonly PropertyCaseKind[];
}

export default function CasesPanel({ cases, verified, propertyId, availableCaseKinds }: CasesPanelProps) {
  const rows = buildRows(cases);
  return (
    <Card size="small" title="案件" extra={<CreateCaseEntry propertyId={propertyId} kinds={availableCaseKinds} />}>
      <Table<CaseRow>
        rowKey="key"
        size="middle"
        dataSource={rows}
        pagination={false}
        scroll={{ x: 'max-content' }}
        expandable={{ defaultExpandAllRows: true }}
        locale={{ emptyText: <EmptyState description={casesEmptyText(verified)} /> }}
        columns={[
          {
            title: '案件',
            render: (_, r) =>
              r.summary ? (
                <Link href={`/cases/${r.summary.id}`}>{r.summary.title || '（未命名案件）'}</Link>
              ) : (
                <Link href={`/cases/${r.placeholder!.id}`}>查看{statusPresentation('caseKind', r.placeholder!.kind).label}</Link>
              ),
          },
          {
            title: '案件種類',
            width: 130,
            render: (_, r) => <StatusTag kind="caseKind" value={r.summary ? r.summary.caseKind : r.placeholder!.kind} />,
          },
          { title: '狀態', width: 96, render: (_, r) => (r.summary ? <StatusTag kind="case" value={r.summary.state} /> : <Typography.Text type="secondary">—</Typography.Text>) },
          { title: '租期', width: 200, render: (_, r) => (r.summary ? leasePeriodLabel(r.summary.leaseStart, r.summary.leaseEnd) : '—') },
          { title: '月租金', width: 100, align: 'right', render: (_, r) => (r.summary ? monthlyRentLabel(r.summary.monthlyRent) : '—') },
        ]}
      />
    </Card>
  );
}
