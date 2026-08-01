'use client';

import { useEffect, useState } from 'react';
import { Table, Tag, Typography, Button } from 'antd';
import Link from 'next/link';
import type { Contract, ContractStatus } from '@/lib/types';
import { CONTRACT_STATUS_LABELS } from '@/lib/types';

const STATUS_COLORS: Record<ContractStatus, string> = {
  draft: 'default',
  awaiting_tenant: 'processing',
  awaiting_landlord: 'warning',
  completed: 'success',
  declined: 'error',
  voided: 'default',
};

export default function ContractsPage() {
  const [items, setItems] = useState<Contract[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/contracts')
      .then((r) => r.json())
      .then((json) => {
        setItems(json.data);
        setLoading(false);
      });
  }, []);

  return (
    <>
      <Typography.Title level={4}>合約</Typography.Title>
      <Table<Contract>
        rowKey="id"
        loading={loading}
        dataSource={items}
        pagination={false}
        columns={[
          { title: '#', dataIndex: 'id', width: 60 },
          { title: '物件', render: (_, r) => r.fields.propertyName || '—' },
          { title: '乙方（租客）', render: (_, r) => r.fields.tenantName || '—' },
          {
            title: '租金',
            width: 110,
            render: (_, r) => (r.fields.rent != null ? `$${r.fields.rent.toLocaleString()}` : '—'),
          },
          {
            title: '租期',
            render: (_, r) =>
              r.fields.startDate && r.fields.endDate ? `${r.fields.startDate} ~ ${r.fields.endDate}` : '—',
          },
          {
            title: '狀態',
            dataIndex: 'status',
            width: 110,
            render: (s: ContractStatus) => <Tag color={STATUS_COLORS[s]}>{CONTRACT_STATUS_LABELS[s]}</Tag>,
          },
          { title: '建立時間', dataIndex: 'created_at', width: 160 },
          {
            title: '操作',
            width: 90,
            render: (_, r) => (
              <Link href={`/contracts/${r.id}`}>
                <Button size="small">開啟</Button>
              </Link>
            ),
          },
        ]}
        locale={{ emptyText: '尚無合約，請從「物件」頁的「建立合約」開始' }}
      />
    </>
  );
}
