'use client';

// 物件詳情「單位」分頁（MIL-145、MIL-177）：同一個物件下自己組織的租賃單位。目前這個營運資料的列標示「目前」。
// 資料由 server component 載入後傳進來，這裡只畫表格。

import { Flex, Table, Tag } from 'antd';
import Link from 'next/link';
import { DisplayCode } from '@/components/DisplayCode';
import EmptyState from '@/components/page/EmptyState';
import { unitFullText } from '@/lib/properties/unit-display';
import type { SiblingUnit } from '@/lib/types';

interface UnitsPanelProps {
  currentId: string;
  units: SiblingUnit[];
}

export default function UnitsPanel({ currentId, units }: UnitsPanelProps) {
  return (
    <Table<SiblingUnit>
      rowKey="property_id"
      size="middle"
      dataSource={units}
      pagination={false}
      scroll={{ x: 'max-content' }}
      locale={{ emptyText: <EmptyState description="同一個物件下沒有其他租賃單位。按右上角「新增分租單位」可以加入。" /> }}
      columns={[
        { title: '顯示編碼', width: 130, render: (_, u) => <DisplayCode code={u.display_code} /> },
        { title: '單位', width: 160, render: (_, u) => unitFullText(u) },
        { title: '樓層', dataIndex: 'floor', width: 80, render: (v: string | null) => v ?? '—' },
        {
          title: '物件',
          render: (_, u) =>
            u.property_id === currentId ? (
              <Flex align="center" gap="small">
                {u.name}
                <Tag>目前</Tag>
              </Flex>
            ) : (
              <Link href={`/properties/${u.property_id}`}>{u.name}</Link>
            ),
        },
        { title: '狀態', width: 100, render: (_, u) => (u.archived_at ? <Tag>已封存</Tag> : <Tag color="success">使用中</Tag>) },
      ]}
    />
  );
}
