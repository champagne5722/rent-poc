'use client';

import { useMemo } from 'react';
import { Button, Card, Col, Flex, Row, Statistic, Table, Typography, type TableColumnsType } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import Link from 'next/link';
import EmptyState from '@/components/page/EmptyState';
import PageHeader from '@/components/page/PageHeader';
import StatusTag from '@/components/StatusTag';
import { lastActionAt } from '@/lib/contract-list';
import { contractTypeDefinition, listSummaryOf } from '@/lib/contract-types';
import { shortUlid } from '@/lib/pg/ulid';
import type { SigningProgressById } from '@/lib/signing-steps';
import type { Contract } from '@/lib/types';
import { selectWorkbenchTodos, todoActionFor, workbenchStats, WORKBENCH_QUICK_LINKS } from '@/lib/workbench';
import styles from './Workbench.module.css';

// 工作台（MIL-178）：登入後第一眼看到「等我處理」的合約，每列連到合約詳情頁。
// 資料由 server component 載入後傳進來，這裡只管畫面。挑選、排序與計數的判斷在 @/lib/workbench。
// 頁首的唯一主要動作是建立合約，去向沿用 WORKBENCH_QUICK_LINKS 的 create。

const CREATE_LINK = WORKBENCH_QUICK_LINKS.find((link) => link.key === 'create');

// 固定用台灣時間，server 與瀏覽器渲染結果一致（見 docs/ui/composite-components.md）
const TIME_FORMAT = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function formatTime(iso: string): string {
  return TIME_FORMAT.format(new Date(iso));
}

export interface WorkbenchProps {
  contracts: Contract[];
  progress: SigningProgressById;
  /** 沒有物件讀取權限時為 null，不顯示物件數字 */
  propertyCount: number | null;
}

function buildColumns(progress: SigningProgressById): TableColumnsType<Contract> {
  return [
    {
      key: 'contract',
      render: (_, contract) => {
        const summary = listSummaryOf(contract);
        const partyBLabel = contractTypeDefinition(contract.contract_type).labels.partyB;
        return (
          <Flex vertical>
            <Link href={`/contracts/${contract.id}`}>
              {summary.propertyName || '（未選物件）'} — {summary.partyB.name || `（未填${partyBLabel}）`}
            </Link>
            <Typography.Text type="secondary" className="type-caption">
              合約 #{shortUlid(contract.id)}・{formatTime(lastActionAt(contract))}
            </Typography.Text>
          </Flex>
        );
      },
    },
    {
      key: 'status',
      width: 120,
      render: (_, contract) => <StatusTag kind="contract" value={contract.status} />,
    },
    {
      key: 'action',
      width: 112,
      align: 'right',
      render: (_, contract) => {
        const action = todoActionFor(contract, progress[String(contract.id)] ?? null);
        return action ? (
          <Link href={action.href}>
            <Button type="link" size="small">
              {action.label}
            </Button>
          </Link>
        ) : null;
      },
    },
  ];
}

export default function Workbench({ contracts, progress, propertyCount }: WorkbenchProps) {
  const stats = useMemo(() => workbenchStats(contracts, propertyCount, progress), [contracts, propertyCount, progress]);
  const columns = useMemo(() => buildColumns(progress), [progress]);
  const todos = useMemo(() => selectWorkbenchTodos(contracts, progress), [contracts, progress]);

  return (
    <Flex vertical gap="large">
      <PageHeader
        title="待處理的事"
        extra={
          CREATE_LINK && (
            <Link href={CREATE_LINK.href}>
              <Button type="primary" icon={<PlusOutlined />}>
                {CREATE_LINK.label}
              </Button>
            </Link>
          )
        }
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={16}>
          <Card size="small" title="等我處理，流程才會前進" extra={<Link href="/contracts">全部合約</Link>}>
            {todos.length === 0 ? (
              <EmptyState
                description={
                  contracts.length === 0
                    ? '尚無合約。建立第一份合約，開始電子簽約。'
                    : '沒有等你處理的合約。輪到你簽署，或有新草稿時，會出現在這裡。'
                }
              />
            ) : (
              <Table<Contract>
                size="middle"
                rowKey="id"
                showHeader={false}
                pagination={false}
                dataSource={todos}
                columns={columns}
              />
            )}
          </Card>
        </Col>

        <Col xs={24} xl={8}>
          <Card size="small" title="概況">
            <Row gutter={[16, 16]}>
              {stats.map((stat) => (
                <Col key={stat.key} span={12}>
                  <Link href={stat.href} className={styles.stat}>
                    <Statistic title={stat.title} value={stat.value} />
                  </Link>
                </Col>
              ))}
            </Row>
          </Card>
        </Col>
      </Row>
    </Flex>
  );
}
