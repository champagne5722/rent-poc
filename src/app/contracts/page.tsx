'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  App as AntApp,
  Button,
  DatePicker,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  CopyOutlined,
  DownloadOutlined,
  EditOutlined,
  FolderOpenOutlined,
  RollbackOutlined,
} from '@ant-design/icons';
import Link from 'next/link';
import dayjs, { type Dayjs } from 'dayjs';
import type { Contract, ContractStatus } from '@/lib/types';
import { CONTRACT_STATUS_LABELS, CONTRACT_STATUSES } from '@/lib/types';
import {
  countByStatus,
  lastActionAt,
  propertyNameOptions,
  selectContracts,
  signingProgressStep,
  SIGNING_PROGRESS_LABELS,
  type ContractListFilter,
} from '@/lib/contract-list';

const STATUS_COLORS: Record<ContractStatus, string> = {
  draft: 'default',
  awaiting_tenant: 'processing',
  awaiting_landlord: 'processing',
  completed: 'success',
  declined: 'error',
  voided: 'warning',
};

const DOT_DONE = '#52c41a';
const DOT_CURRENT = '#1677ff';
const DOT_PENDING = 'rgba(5, 5, 5, 0.15)';

// 簽署進度三點：乙方簽 → 甲方簽 → 完成；簽署流程外的狀態顯示「—」。
function SigningProgress({ status }: { status: ContractStatus }) {
  const step = signingProgressStep(status);
  if (step == null) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        —
      </Typography.Text>
    );
  }
  return (
    <Space size={4}>
      {SIGNING_PROGRESS_LABELS.map((label, i) => (
        <Tooltip key={label} title={label}>
          <span
            style={{
              display: 'inline-block',
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: i < step ? DOT_DONE : i === step ? DOT_CURRENT : DOT_PENDING,
            }}
          />
        </Tooltip>
      ))}
    </Space>
  );
}

async function fetchContracts(): Promise<Contract[]> {
  const res = await fetch('/api/contracts');
  const json = await res.json();
  return json.data ?? [];
}

function ContractList() {
  const { message } = AntApp.useApp();
  const [items, setItems] = useState<Contract[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [status, setStatus] = useState<ContractStatus | 'all'>('all');
  const [propertyName, setPropertyName] = useState<string | null>(null);
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(null);

  useEffect(() => {
    fetchContracts().then((data) => {
      setItems(data);
      setLoading(false);
    });
  }, []);

  const counts = useMemo(() => countByStatus(items), [items]);
  const propertyOptions = useMemo(
    () => propertyNameOptions(items).map((n) => ({ value: n, label: n })),
    [items]
  );

  const filter: ContractListFilter = useMemo(
    () => ({
      status,
      propertyName,
      leaseRange: range ? [range[0].format('YYYY-MM-DD'), range[1].format('YYYY-MM-DD')] : null,
    }),
    [status, propertyName, range]
  );
  const rows = useMemo(() => selectContracts(items, filter), [items, filter]);

  // 列上快速操作共用：呼叫既有 API，成功後重新載入列表
  const act = async (contract: Contract, path: string, successText: string) => {
    setBusyId(contract.id);
    try {
      const res = await fetch(path, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) {
        message.error(json.error ?? '操作失敗');
        return;
      }
      message.success(successText);
      setItems(await fetchContracts());
    } finally {
      setBusyId(null);
    }
  };

  const rowActions = (c: Contract) => {
    const isSigning = c.status === 'awaiting_tenant' || c.status === 'awaiting_landlord';
    const busy = busyId === c.id;
    return (
      <Space size={4}>
        {c.status === 'draft' && (
          <Link href={`/contracts/${c.id}/edit`}>
            <Button size="small" icon={<EditOutlined />}>
              繼續編輯
            </Button>
          </Link>
        )}
        {isSigning && (
          <Popconfirm
            title="撤回後需複製為新草稿重新送簽，確定？"
            okText="確定撤回"
            cancelText="取消"
            onConfirm={() => act(c, `/api/contracts/${c.id}/void`, `合約 #${c.id} 已撤回`)}
          >
            <Button size="small" danger icon={<RollbackOutlined />} loading={busy}>
              撤回
            </Button>
          </Popconfirm>
        )}
        {c.status === 'completed' && (
          <Button size="small" icon={<DownloadOutlined />} href={`/api/contracts/${c.id}/signed-pdf`}>
            已簽 PDF
          </Button>
        )}
        {(c.status === 'declined' || c.status === 'voided') && (
          <Button
            size="small"
            icon={<CopyOutlined />}
            loading={busy}
            onClick={() => act(c, `/api/contracts/${c.id}/copy`, `已複製合約 #${c.id} 為新草稿`)}
          >
            複製為新草稿
          </Button>
        )}
        <Link href={`/contracts/${c.id}`}>
          <Button size="small" type="primary" ghost icon={<FolderOpenOutlined />}>
            開啟
          </Button>
        </Link>
      </Space>
    );
  };

  return (
    <>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 12 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          合約
        </Typography.Title>
        <Space>
          <Select
            allowClear
            placeholder="物件"
            style={{ width: 180 }}
            options={propertyOptions}
            value={propertyName}
            onChange={(v) => setPropertyName(v ?? null)}
          />
          <DatePicker.RangePicker
            placeholder={['租期涵蓋起', '租期涵蓋迄']}
            value={range}
            onChange={(v) => setRange(v && v[0] && v[1] ? [v[0], v[1]] : null)}
          />
        </Space>
      </Space>

      <Segmented<ContractStatus | 'all'>
        style={{ marginBottom: 12 }}
        value={status}
        onChange={setStatus}
        options={[
          { value: 'all', label: `全部 ${items.length}` },
          ...CONTRACT_STATUSES.map((s) => ({
            value: s,
            label: `${CONTRACT_STATUS_LABELS[s]} ${counts[s]}`,
          })),
        ]}
      />

      <Table<Contract>
        rowKey="id"
        size="middle"
        loading={loading}
        dataSource={rows}
        pagination={false}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: '#', dataIndex: 'id', width: 56 },
          { title: '物件', render: (_, r) => r.fields.propertyName || '—' },
          { title: '乙方（租客）', render: (_, r) => r.fields.tenantName || '—' },
          {
            title: '租金',
            width: 100,
            render: (_, r) => (r.fields.rent != null ? `$${r.fields.rent.toLocaleString()}` : '—'),
          },
          {
            title: '租期',
            width: 210,
            render: (_, r) =>
              r.fields.startDate && r.fields.endDate ? `${r.fields.startDate} ~ ${r.fields.endDate}` : '—',
          },
          {
            title: '狀態',
            width: 100,
            render: (_, r) => <Tag color={STATUS_COLORS[r.status]}>{CONTRACT_STATUS_LABELS[r.status]}</Tag>,
          },
          { title: '簽署進度', width: 100, render: (_, r) => <SigningProgress status={r.status} /> },
          {
            title: '最後動作',
            width: 120,
            render: (_, r) => dayjs(lastActionAt(r)).format('MM-DD HH:mm'),
          },
          { title: '操作', width: 250, render: (_, r) => rowActions(r) },
        ]}
        locale={{
          emptyText:
            items.length === 0 ? '尚無合約，點側邊選單的「＋建立合約」開始' : '此條件下沒有合約',
        }}
      />
    </>
  );
}

export default function ContractsPage() {
  return (
    <AntApp>
      <ContractList />
    </AntApp>
  );
}
