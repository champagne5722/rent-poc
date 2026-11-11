'use client';

// 物件詳情的「案件」區（MIL-177、MIL-209，ADR-0030 決議 5）：看得出兩層。
// 委託管理案件與底下的租賃案件，或包租案件與底下的轉租案件。上層案件不在這個物件的案件裡時，上層列只有種類與連結。
// 這裡不放建立案件的入口，入口由功能線的畫面段加入。

import { Card, Table, Typography } from 'antd';
import Link from 'next/link';
import EmptyState from '@/components/page/EmptyState';
import StatusTag from '@/components/StatusTag';
import { leasePeriodLabel, monthlyRentLabel } from '@/lib/case-display';
import type { CaseSummary } from '@/lib/case-store';
import { buildCaseLayers } from '@/lib/property-case-layers';
import { statusPresentation } from '@/lib/status-presentation';

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

export default function CasesPanel({ cases }: { cases: CaseSummary[] }) {
  const rows = buildRows(cases);
  return (
    <Card size="small" title="案件">
      <Table<CaseRow>
        rowKey="key"
        size="middle"
        dataSource={rows}
        pagination={false}
        scroll={{ x: 'max-content' }}
        expandable={{ defaultExpandAllRows: true }}
        locale={{ emptyText: <EmptyState description="這個物件還沒有案件。物件通過平台文件核對後，就能建立案件。" /> }}
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
