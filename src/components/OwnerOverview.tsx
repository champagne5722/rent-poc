'use client';

// 屋主資產總覽（MIL-96，版面以 MIL-47 prototype 的 O-B 為起點）。
// 由上而下：頁首彙總、執業主體已失效的橫幅、需要注意清單、全部租賃單位與篩選。
// 資料全部由 server 端推導好再傳進來；這裡只負責篩選狀態與呈現。
// 不顯示承租人姓名、估值、報酬率、投資建議（P0-20 規則 5）。

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Alert, Button, Card, Checkbox, Descriptions, Flex, Statistic, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  EMPTY_FILTER,
  filterRows,
  type AttentionItem,
  type AttentionKind,
  type AuthorityStatus,
  type DepositHolder,
  type LeaseState,
  type OverviewFilter,
  type OverviewKind,
  type OverviewRow,
  type OverviewSummary,
  type PracticeEntityStatus,
} from '@/lib/owner-overview';
import { caseKindLabel, leaseBusinessTypeLabel } from '@/lib/case-display';
import { statusPresentation } from '@/lib/status-presentation';
import EmptyState from './page/EmptyState';
import FilterBar from './page/FilterBar';
import PageHeader from './page/PageHeader';
import StatusTag from './StatusTag';
import styles from './OwnerOverview.module.css';

const { Text } = Typography;

const HANDOVERS_HREF = '/owner/handovers';

/** 篩選選項對應的案件事實，名稱取自案件種類的法定名稱（MIL-198）。 */
const OVERVIEW_KIND_FACTS: Record<OverviewKind, Pick<OverviewRow, 'caseKind' | 'businessType'>> = {
  lease_self_managed: { caseKind: 'lease', businessType: 'self_managed' },
  lease_managed: { caseKind: 'lease', businessType: 'managed' },
  master_lease: { caseKind: 'master_lease', businessType: 'self_managed' },
};

const MANAGER_STATUS_LABEL: Record<PracticeEntityStatus, string> = {
  verified: '已驗證',
  pending: '待驗證',
  revoked: '已失效',
};

const DEPOSIT_HOLDER_LABEL: Record<DepositHolder, string> = {
  owner: '屋主持有',
  manager: '代管業者持有',
  other: '其他人持有',
};

const ATTENTION_LABEL: Record<AttentionKind, string> = {
  overdue: '逾期',
  authority_problem: '出租權源',
  collected_funds_overdue: '代收交付逾期',
  deposit_settlement: '押金結算',
  authority_pending: '出租權源',
  lease_expiring: '合約到期',
};

const ERROR_KINDS: ReadonlySet<AttentionKind> = new Set(['overdue', 'authority_problem', 'collected_funds_overdue']);

function money(value: number) {
  return <span className={styles.num}>{value.toLocaleString('zh-TW')}</span>;
}

function attentionFact(item: AttentionItem): string {
  switch (item.kind) {
    case 'overdue':
      return `逾期 ${(item.amount ?? 0).toLocaleString('zh-TW')} 元，是全部已逾期期別的累計未足額。`;
    case 'authority_problem':
    case 'authority_pending':
      return `出租權源${statusPresentation('leaseAuthority', item.authority ?? 'pending').label}。`;
    case 'collected_funds_overdue':
      return `代收的租金或押金超過約定日數 ${item.days} 天未交付。`;
    case 'deposit_settlement':
      return item.days === null ? '押金結算中。' : `押金結算中，自退租點交起算第 ${item.days} 天。`;
    case 'lease_expiring':
      return (item.days ?? 0) >= 0
        ? `合約剩 ${item.days} 天到期。`
        : `合約已過到期日 ${-(item.days ?? 0)} 天，仍在出租中。`;
  }
}

// ─── 頁首 ──────────────────────────────────────────────────────────

function OverviewStats({ summary }: { summary: OverviewSummary }) {
  const stat = (title: string, value: number, danger = false) => (
    <Statistic
      title={title}
      value={value}
      groupSeparator=","
      classNames={{ content: danger ? `${styles.statValue} ${styles.statDanger}` : styles.statValue }}
    />
  );

  return (
    <Card size="small">
      <div className={styles.stats}>
        <div className={styles.statGroup}>
          {stat('單位數', summary.unitCount)}
          {stat('出租中', summary.leased)}
          {stat('空置', summary.vacant)}
        </div>
        <div className={styles.statGroup}>
          {stat('本月應收', summary.receivable)}
          {stat('已入帳', summary.received)}
          {stat('逾期', summary.overdue, summary.overdue > 0)}
          {stat('押金餘額', summary.depositBalance)}
          {stat('未完成修繕', summary.openRepairs)}
        </div>
      </div>
    </Card>
  );
}

function RevokedManagerBanners({ summary }: { summary: OverviewSummary }) {
  return summary.revokedManagers.map(({ manager, unitCount }) => (
    <Alert
      key={manager.id}
      type="error"
      showIcon
      title={`${manager.legalTitle}「${manager.name}」的執業主體已失效，影響 ${unitCount} 個租賃單位`}
      // 按鈕放在說明下方：放在右側 action 時，375px 寬的標題會被擠成四行
      description={
        <Flex vertical gap="small" align="flex-start">
          <span>請發起移交，選擇新受託人或改為自管。</span>
          {/* TODO(MIL-108)：依 C 線的 authorize() 結果決定是否顯示，這張票先一律顯示 */}
          <Button href={HANDOVERS_HREF}>發起移交</Button>
        </Flex>
      }
    />
  ));
}

// ─── 需要注意清單 ───────────────────────────────────────────────────

function AttentionList({ items }: { items: AttentionItem[] }) {
  return (
    <Card size="small" title={`需要注意（${items.length} 件）`}>
      {items.length === 0 ? (
        <EmptyState description="目前沒有需要注意的項目。" />
      ) : (
        <div>
          {items.map((item) => (
            <div key={item.key} className={styles.attentionItem}>
              <Tag color={ERROR_KINDS.has(item.kind) ? 'error' : 'warning'} className={styles.attentionTag}>
                {ATTENTION_LABEL[item.kind]}
              </Tag>
              <Flex vertical gap="var(--space-xxs)" className={styles.attentionBody}>
                <Text>
                  {item.address}
                  <Text type="secondary">，{item.unitLabel}</Text>
                </Text>
                <Text type="secondary">{attentionFact(item)}</Text>
              </Flex>
              {item.href ? (
                // TODO(MIL-108)：依 authorize() 結果決定是否顯示
                <Link href={item.href}>查看合約</Link>
              ) : (
                <span />
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ─── 每列的欄位 ─────────────────────────────────────────────────────

function UnitCell({ row }: { row: OverviewRow }) {
  return (
    <Flex vertical gap="var(--space-xxs)">
      {row.href ? <Link href={row.href}>{row.address}</Link> : <Text>{row.address}</Text>}
      <Text type="secondary" className={styles.num}>
        {row.unitLabel}・{row.unitId}
      </Text>
    </Flex>
  );
}

/** 業者的名稱、法定稱謂與驗證狀態（GLOSSARY「經理人」：介面顯示法定稱謂）。表格與卡片共用。 */
function PractitionerInfo({ row }: { row: OverviewRow }) {
  return (
    <Flex vertical gap="var(--space-xxs)" align="flex-start">
      {row.manager ? (
        <>
          <Text>{row.manager.name}</Text>
          <Text type={row.manager.status === 'revoked' ? 'danger' : 'secondary'}>
            {row.manager.legalTitle}・{MANAGER_STATUS_LABEL[row.manager.status]}
          </Text>
        </>
      ) : (
        <Text type="secondary">屋主自管</Text>
      )}
      {row.caseKind === 'master_lease' && <Text type="secondary">屋主與包租業者的合約</Text>}
    </Flex>
  );
}

/** 案件種類的法定名稱。租賃案件加業務類型（自管或代管），其他案件種類沒有業務類型。 */
function CaseKindTags({ row }: { row: OverviewRow }) {
  const businessTypeLabel = leaseBusinessTypeLabel(row.caseKind, row.businessType);
  return (
    <Flex wrap gap="var(--space-xxs)">
      <StatusTag kind="caseKind" value={row.caseKind} />
      {businessTypeLabel && <Tag>{businessTypeLabel}</Tag>}
    </Flex>
  );
}

function LeaseStateTag({ state }: { state: LeaseState }) {
  return <StatusTag kind="leaseState" value={state} />;
}

/** 合約狀態下方的說明：簽約中先寫等待誰簽署，再寫到期日。 */
function LeaseNotes({ row }: { row: OverviewRow }) {
  return (
    <Flex vertical gap="var(--space-xxs)" align="flex-start">
      {row.leaseState === 'signing' && row.awaitingSigner && <Text>等待{row.awaitingSigner}簽署</Text>}
      <Text type="secondary" className={styles.num}>
        {row.leaseEnd ? `${row.leaseEnd} 到期` : '無到期日'}
      </Text>
    </Flex>
  );
}

function RentCell({ row, align }: { row: OverviewRow; align: 'flex-start' | 'flex-end' }) {
  if (row.receivable === 0 && row.overdue === 0) return <Text type="secondary">無應收</Text>;
  return (
    <Flex vertical gap="var(--space-xxs)" align={align}>
      <span>
        {money(row.received)} / {money(row.receivable)}
      </span>
      {row.overdue > 0 && <Text type="danger">逾期 {money(row.overdue)}</Text>}
    </Flex>
  );
}

function HolderLabel({ holder }: { holder: DepositHolder | null }) {
  if (!holder) return <Text type="secondary">未收取</Text>;
  // 代管業者持有時標示（MIL-47 決議）；本身不進需要注意清單
  if (holder === 'manager') return <Tag color="warning">{DEPOSIT_HOLDER_LABEL[holder]}</Tag>;
  return <Text type="secondary">{DEPOSIT_HOLDER_LABEL[holder]}</Text>;
}

function DepositCell({ row, align }: { row: OverviewRow; align: 'flex-start' | 'flex-end' }) {
  if (row.depositExpected === 0 && row.depositBalance === 0) return <Text type="secondary">無押金</Text>;
  return (
    <Flex vertical gap="var(--space-xxs)" align={align}>
      <span>
        {money(row.depositBalance)} / {money(row.depositExpected)}
      </span>
      <HolderLabel holder={row.depositHolder} />
    </Flex>
  );
}

function AuthorityTag({ status }: { status: AuthorityStatus }) {
  return <StatusTag kind="leaseAuthority" value={status} />;
}

// ─── 全部租賃單位 ───────────────────────────────────────────────────

const COLUMNS: ColumnsType<OverviewRow> = [
  { title: '租賃單位', key: 'unit', render: (_, r) => <UnitCell row={r} /> },
  {
    title: '案件種類與業者',
    key: 'manager',
    width: 220,
    render: (_, r) => (
      <Flex vertical gap="var(--space-xxs)" align="flex-start">
        <CaseKindTags row={r} />
        <PractitionerInfo row={r} />
      </Flex>
    ),
  },
  {
    title: '合約',
    key: 'lease',
    width: 150,
    render: (_, r) => (
      <Flex vertical gap="var(--space-xxs)" align="flex-start">
        <LeaseStateTag state={r.leaseState} />
        <LeaseNotes row={r} />
      </Flex>
    ),
  },
  {
    title: '本月入帳／應收',
    key: 'rent',
    align: 'right',
    width: 150,
    render: (_, r) => <RentCell row={r} align="flex-end" />,
  },
  {
    title: '押金餘額／約定',
    key: 'deposit',
    align: 'right',
    width: 160,
    render: (_, r) => <DepositCell row={r} align="flex-end" />,
  },
  { title: '修繕', key: 'repairs', align: 'right', width: 64, render: (_, r) => money(r.openRepairs) },
  { title: '出租權源', key: 'authority', width: 100, render: (_, r) => <AuthorityTag status={r.authority} /> },
  {
    title: '帳務更新日',
    key: 'ledger',
    align: 'right',
    width: 112,
    render: (_, r) => <span className={styles.num}>{r.ledgerUpdatedOn ?? '無'}</span>,
  },
];

function UnitCard({ row }: { row: OverviewRow }) {
  return (
    <Card size="small">
      <Flex vertical gap="small">
        <UnitCell row={row} />
        <Flex wrap gap="var(--space-xxs)">
          <CaseKindTags row={row} />
          <LeaseStateTag state={row.leaseState} />
        </Flex>
        <Descriptions
          size="small"
          column={1}
          items={[
            { key: 'manager', label: '業者', children: <PractitionerInfo row={row} /> },
            { key: 'lease', label: '合約', children: <LeaseNotes row={row} /> },
            { key: 'rent', label: '本月入帳／應收', children: <RentCell row={row} align="flex-start" /> },
            { key: 'deposit', label: '押金餘額／約定', children: <DepositCell row={row} align="flex-start" /> },
            { key: 'repairs', label: '未完成修繕', children: money(row.openRepairs) },
            { key: 'authority', label: '出租權源', children: <AuthorityTag status={row.authority} /> },
            { key: 'ledger', label: '帳務更新日', children: row.ledgerUpdatedOn ?? '無' },
          ]}
        />
      </Flex>
    </Card>
  );
}

const KIND_OPTIONS: { value: OverviewFilter['kind']; label: string }[] = [
  { value: 'all', label: '全部' },
  ...(Object.entries(OVERVIEW_KIND_FACTS) as [OverviewKind, (typeof OVERVIEW_KIND_FACTS)[OverviewKind]][]).map(
    ([value, facts]) => ({ value, label: caseKindLabel(facts.caseKind, facts.businessType) }),
  ),
];

function UnitFilters({ filter, onChange }: { filter: OverviewFilter; onChange: (next: OverviewFilter) => void }) {
  const toggle = (key: 'overdue' | 'expiringSoon' | 'authorityUnverified', label: string) => (
    <Checkbox checked={filter[key]} onChange={(e) => onChange({ ...filter, [key]: e.target.checked })}>
      {label}
    </Checkbox>
  );
  return (
    <FilterBar<OverviewFilter['kind']>
      status={{
        value: filter.kind,
        options: KIND_OPTIONS,
        onChange: (value) => onChange({ ...filter, kind: value }),
      }}
      active={JSON.stringify(filter) !== JSON.stringify(EMPTY_FILTER)}
      onClear={() => onChange(EMPTY_FILTER)}
    >
      {toggle('overdue', '逾期')}
      {toggle('expiringSoon', '60 天內到期')}
      {toggle('authorityUnverified', '權源未驗證')}
    </FilterBar>
  );
}

function UnitList({ rows }: { rows: OverviewRow[] }) {
  const router = useRouter();
  const [filter, setFilter] = useState<OverviewFilter>(EMPTY_FILTER);
  const visible = useMemo(() => filterRows(rows, filter), [rows, filter]);
  const filtered = visible.length !== rows.length;

  const noMatch = (
    <EmptyState
      description="沒有符合篩選條件的租賃單位"
      action={<Button onClick={() => setFilter(EMPTY_FILTER)}>清除篩選</Button>}
    />
  );

  return (
    <Flex vertical gap="middle">
      <Flex justify="space-between" align="baseline" wrap gap="small">
        <h2 className="type-section-title">全部租賃單位（{rows.length}）</h2>
        {filtered && <Text type="secondary">符合篩選 {visible.length} 個</Text>}
      </Flex>
      <UnitFilters filter={filter} onChange={setFilter} />

      <Card size="small" className={styles.table} styles={{ body: { padding: 0 } }}>
        <Table<OverviewRow>
          rowKey="unitId"
          size="middle"
          pagination={false}
          columns={COLUMNS}
          dataSource={visible}
          locale={{ emptyText: noMatch }}
          // 屋主組織的列可點；其他組織的列等 C 線的案件頁（MIL-94）
          onRow={(r) => ({
            onClick: r.href ? () => router.push(r.href as string) : undefined,
            className: r.href ? styles.clickRow : undefined,
          })}
        />
      </Card>

      <div className={styles.cards}>
        {visible.length === 0 ? <Card>{noMatch}</Card> : visible.map((r) => <UnitCard key={r.unitId} row={r} />)}
      </div>
    </Flex>
  );
}

// ─── 頁面 ──────────────────────────────────────────────────────────

export default function OwnerOverview({
  summary,
  rows,
  attention,
  asOfLabel,
}: {
  summary: OverviewSummary;
  rows: OverviewRow[];
  attention: AttentionItem[];
  asOfLabel: string;
}) {
  const header = <PageHeader title="資產總覽" />;

  if (rows.length === 0) {
    // 沒有任何租賃單位時不顯示全為 0 的彙總，只留標題與說明
    return (
      <Flex vertical gap="large">
        {header}
        <Card size="small">
          <EmptyState
            description={
              <Flex vertical gap="xs">
                <Text strong>還沒有任何租賃單位</Text>
                <Text type="secondary">
                  你自己的物件、你出租中的租賃單位，以及委託代管業者管理的租賃單位，都會列在這裡。
                </Text>
              </Flex>
            }
          />
        </Card>
      </Flex>
    );
  }

  return (
    <Flex vertical gap="large">
      {header}
      <Text type="secondary">資料截至 {asOfLabel}。金額以銀行紀錄為準。</Text>
      <OverviewStats summary={summary} />
      <RevokedManagerBanners summary={summary} />
      <AttentionList items={attention} />
      <UnitList rows={rows} />
    </Flex>
  );
}
