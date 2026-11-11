'use client';

import { useMemo, useState, useTransition } from 'react';
import {
  App as AntApp,
  Button,
  DatePicker,
  Popconfirm,
  Select,
  Space,
  Tooltip,
  Typography,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import dayjs, { type Dayjs } from 'dayjs';
import { DisplayCode } from '@/components/DisplayCode';
import ListPage from '@/components/page/ListPage';
import StatusTag from '@/components/StatusTag';
import {
  countByStatus,
  EMPTY_CONTRACT_LIST_FILTER,
  lastActionAt,
  listPartyBColumn,
  listPeriodLabel,
  listPropertyLabel,
  listRentLabel,
  listSigningDots,
  propertyNameOptions,
  selectContracts,
  statusTabs,
  type ContractListFilter,
} from '@/lib/contract-list';
import { CREATE_CONTRACT_HREF } from '@/lib/nav';
import { shortUlid } from '@/lib/pg/ulid';
import type { SigningProgressById, SigningProgressInput } from '@/lib/signing-steps';
import type { Contract, ContractStatus } from '@/lib/types';
import { CONTRACT_STATUS_LABELS, isSigningStatus } from '@/lib/types';
import styles from './ContractList.module.css';

// 合約列表（MIL-174）：套用列表頁版型。資料由 server component 載入後傳進來，這裡只管篩選與列上操作。
// 列上操作成功後呼叫 router.refresh()，讓 server component 重新載入資料。

const DOT_CLASS = { done: styles.done, current: styles.current, pending: styles.pending } as const;

// 簽署進度點：每位簽署人一點，最後多一點「完成」，由實際的簽署序列推導（MIL-72）。
// 兩方合約是乙方簽、甲方簽、完成三點。簽署流程外的狀態顯示「—」。
function SigningProgress({ contract, progress }: { contract: Contract; progress: SigningProgressInput | null }) {
  const dots = listSigningDots(contract, progress);
  if (dots == null) return <Typography.Text type="secondary">—</Typography.Text>;
  return (
    <Space size="small">
      {dots.map(({ label, state }) => (
        <Tooltip key={label} title={label}>
          <span className={`${styles.dot} ${DOT_CLASS[state]}`} role="img" aria-label={label} />
        </Tooltip>
      ))}
    </Space>
  );
}

export interface ContractListProps {
  contracts: Contract[];
  // 以合約編號為鍵。沒有簽署任務的合約不在裡面
  progress: SigningProgressById;
  // 物件 ID 到顯示編碼的對照（MIL-145）
  displayCodes: Record<string, string | null>;
}

function ContractListInner({ contracts, progress, displayCodes }: ContractListProps) {
  const { message } = AntApp.useApp();
  const router = useRouter();
  const [, startRefresh] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [status, setStatus] = useState<ContractStatus | 'all'>('all');
  const [propertyName, setPropertyName] = useState<string | null>(null);
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(null);

  const counts = useMemo(() => countByStatus(contracts), [contracts]);
  const propertyOptions = useMemo(
    () => propertyNameOptions(contracts).map((n) => ({ value: n, label: n })),
    [contracts],
  );

  const filter: ContractListFilter = useMemo(
    () => ({
      status,
      propertyName,
      leaseRange: range ? [range[0].format('YYYY-MM-DD'), range[1].format('YYYY-MM-DD')] : null,
    }),
    [status, propertyName, range],
  );
  const rows = useMemo(() => selectContracts(contracts, filter), [contracts, filter]);
  // 乙方欄的欄名與儲存格依合約類型取字（MIL-122、MIL-73）
  const partyB = useMemo(() => listPartyBColumn(rows), [rows]);

  const clearFilter = () => {
    setStatus(EMPTY_CONTRACT_LIST_FILTER.status);
    setPropertyName(EMPTY_CONTRACT_LIST_FILTER.propertyName);
    setRange(null);
  };

  // 列上快速操作共用：呼叫既有 API，成功後請 server component 重新載入
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
      startRefresh(() => router.refresh());
    } finally {
      setBusyId(null);
    }
  };

  const rowActions = (c: Contract) => {
    const isSigning = isSigningStatus(c.status);
    const busy = busyId === c.id;
    return (
      <Space size={0}>
        {c.status === 'draft' && (
          <Link href={`/contracts/${c.id}/edit`}>
            <Button type="link" size="small">
              繼續編輯
            </Button>
          </Link>
        )}
        <Link href={`/contracts/${c.id}`}>
          <Button type="link" size="small">
            開啟
          </Button>
        </Link>
        {isSigning && (
          <Popconfirm
            title="撤回後需複製為新草稿重新送簽，確定？"
            okText="確定撤回"
            cancelText="取消"
            onConfirm={() => void act(c, `/api/contracts/${c.id}/void`, `合約 #${shortUlid(c.id)} 已撤回`)}
          >
            <Button type="link" size="small" danger loading={busy}>
              撤回
            </Button>
          </Popconfirm>
        )}
        {c.status === 'completed' && (
          <Button type="link" size="small" href={`/api/contracts/${c.id}/signed-pdf`}>
            已簽 PDF
          </Button>
        )}
        {(c.status === 'declined' || c.status === 'voided') && (
          <Button
            type="link"
            size="small"
            loading={busy}
            onClick={() => void act(c, `/api/contracts/${c.id}/copy`, `已複製合約 #${shortUlid(c.id)} 為新草稿`)}
          >
            複製為新草稿
          </Button>
        )}
      </Space>
    );
  };

  return (
    <ListPage<Contract, ContractStatus | 'all'>
      header={{ title: '合約列表' }}
      filter={{
        status: {
          value: status,
          onChange: setStatus,
          options: [
            { value: 'all', label: '全部', count: contracts.length },
            ...statusTabs(counts, status).map((s) => ({ value: s, label: CONTRACT_STATUS_LABELS[s], count: counts[s] })),
          ],
        },
        active: status !== 'all' || propertyName !== null || range !== null,
        onClear: clearFilter,
        children: (
          <>
            <Select
              allowClear
              placeholder="物件"
              options={propertyOptions}
              value={propertyName}
              onChange={(v) => setPropertyName(v ?? null)}
              className={styles.propertySelect}
            />
            <DatePicker.RangePicker
              placeholder={['租期涵蓋起', '租期涵蓋迄']}
              value={range}
              onChange={(v) => setRange(v && v[0] && v[1] ? [v[0], v[1]] : null)}
            />
          </>
        ),
      }}
      empty={{
        description: '尚無合約。從物件建立第一份合約，開始電子簽約。',
        action: (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => router.push(CREATE_CONTRACT_HREF)}>
            建立合約
          </Button>
        ),
      }}
      table={{
        rowKey: 'id',
        dataSource: rows,
        scroll: { x: 1100 },
        columns: [
          {
            // 合約 ID（ULID）的末 6 碼，口頭溝通與客服對照用，不保證唯一；系統內與網址一律用完整 ULID。
            title: 'ID 末碼',
            dataIndex: 'id',
            width: 90,
            render: (id: string) => (
              <Typography.Text type="secondary" code title={id}>
                {shortUlid(id)}
              </Typography.Text>
            ),
          },
          { title: '物件', render: (_, r) => listPropertyLabel(r) },
          {
            title: '顯示編碼',
            width: 110,
            render: (_, r) =>
              r.property_id && r.property_id in displayCodes ? <DisplayCode code={displayCodes[r.property_id]} /> : '—',
          },
          { title: partyB.title, render: (_, r) => partyB.cell(r) },
          { title: '租金', width: 90, align: 'right', render: (_, r) => listRentLabel(r) },
          { title: '租期', width: 215, render: (_, r) => listPeriodLabel(r) },
          { title: '狀態', width: 84, render: (_, r) => <StatusTag kind="contract" value={r.status} /> },
          {
            title: '簽署進度',
            width: 84,
            render: (_, r) => <SigningProgress contract={r} progress={progress[String(r.id)] ?? null} />,
          },
          { title: '最後動作', width: 108, render: (_, r) => dayjs(lastActionAt(r)).format('MM-DD HH:mm') },
          // 操作欄固定在最右，表格橫向捲動時仍看得到（規格 39）
          { title: '操作', width: 170, fixed: 'right', render: (_, r) => rowActions(r) },
        ],
      }}
    />
  );
}

export default function ContractList(props: ContractListProps) {
  return (
    <AntApp>
      <ContractListInner {...props} />
    </AntApp>
  );
}
