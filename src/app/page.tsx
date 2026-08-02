'use client';

// 工作台＝登入後預設落地頁（規格 §5），精簡三模組：核心數據 4 卡、待辦（窄規則）、快捷入口。
// 不加第 4 個模組；挑選、排序與計數的判斷都在 @/lib/workbench，這裡只負責取資料與畫畫面。

import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Col, Empty, Row, Space, Statistic, Tag, Typography } from 'antd';
import {
  EditOutlined,
  FileTextOutlined,
  HomeOutlined,
  PlusOutlined,
  SignatureOutlined,
} from '@ant-design/icons';
import Link from 'next/link';
import dayjs from 'dayjs';
import type { Contract, ContractStatus, Property } from '@/lib/types';
import { CONTRACT_STATUS_LABELS } from '@/lib/types';
import { lastActionAt } from '@/lib/contract-list';
import {
  selectWorkbenchTodos,
  todoActionFor,
  workbenchStats,
  WORKBENCH_QUICK_LINKS,
  type WorkbenchQuickLink,
} from '@/lib/workbench';

const STATUS_COLORS: Partial<Record<ContractStatus, string>> = {
  draft: 'default',
  awaiting_landlord: 'processing',
};

const QUICK_LINK_ICONS: Record<WorkbenchQuickLink['key'], React.ReactNode> = {
  create: <PlusOutlined />,
  contracts: <FileTextOutlined />,
  properties: <HomeOutlined />,
};

const TODO_ACTION_ICONS: Partial<Record<ContractStatus, React.ReactNode>> = {
  awaiting_landlord: <SignatureOutlined />,
  draft: <EditOutlined />,
};

function TodoRow({ contract }: { contract: Contract }) {
  const action = todoActionFor(contract);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500 }}>
          {contract.fields.propertyName || '（未選物件）'} —{' '}
          {contract.fields.tenantName || '（未填租客）'}
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          合約 #{contract.id}・{dayjs(lastActionAt(contract)).format('MM-DD HH:mm')}
        </Typography.Text>
      </div>
      <Tag color={STATUS_COLORS[contract.status]}>{CONTRACT_STATUS_LABELS[contract.status]}</Tag>
      {action && (
        <Link href={action.href}>
          <Button
            size="small"
            type={contract.status === 'awaiting_landlord' ? 'primary' : 'default'}
            icon={TODO_ACTION_ICONS[contract.status]}
          >
            {action.label}
          </Button>
        </Link>
      )}
    </div>
  );
}

export default function WorkbenchPage() {
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch('/api/contracts').then((r) => r.json()),
      fetch('/api/properties').then((r) => r.json()),
    ]).then(([contractsJson, propertiesJson]) => {
      setContracts(contractsJson.data ?? []);
      setProperties(propertiesJson.data ?? []);
      setLoading(false);
    });
  }, []);

  const stats = useMemo(
    () => workbenchStats(contracts, properties.length),
    [contracts, properties.length]
  );
  const todos = useMemo(() => selectWorkbenchTodos(contracts), [contracts]);

  return (
    <>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        工作台
      </Typography.Title>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* 模組一：核心數據 4 卡，整張卡可點連到對應頁面 */}
        <Row gutter={[16, 16]}>
          {stats.map((stat) => (
            <Col key={stat.key} xs={12} lg={6}>
              <Link href={stat.href}>
                <Card hoverable>
                  <Statistic title={stat.title} value={stat.value} loading={loading} />
                </Card>
              </Link>
            </Col>
          ))}
        </Row>

        <Row gutter={[16, 16]}>
          {/* 模組二：待辦（窄規則）——只收等房東動作、流程才會前進的合約 */}
          <Col xs={24} lg={16}>
            <Card
              title="待辦（等我動作，流程才會前進）"
              extra={<Link href="/contracts">全部合約</Link>}
              loading={loading}
            >
              {todos.length === 0 ? (
                <Empty description="沒有待辦" />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {todos.map((contract, i) => (
                    <div
                      key={contract.id}
                      style={{ borderTop: i === 0 ? 'none' : '1px solid rgba(5,5,5,0.06)' }}
                    >
                      <TodoRow contract={contract} />
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </Col>

          {/* 模組三：快捷入口 */}
          <Col xs={24} lg={8}>
            <Card title="快捷入口">
              <Space orientation="vertical" size={8} style={{ width: '100%' }}>
                {WORKBENCH_QUICK_LINKS.map((link) => (
                  <Link key={link.key} href={link.href} style={{ display: 'block' }}>
                    <Button
                      block
                      type={link.primary ? 'primary' : 'default'}
                      icon={QUICK_LINK_ICONS[link.key]}
                    >
                      {link.label}
                    </Button>
                  </Link>
                ))}
              </Space>
            </Card>
          </Col>
        </Row>
      </div>
    </>
  );
}
