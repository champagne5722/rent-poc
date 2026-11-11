'use client';

// 物件詳情頁（MIL-143、MIL-145、MIL-196、MIL-177）：詳情頁版型，主要內容用三個分頁：基本資料／建號與核對／單位。
// 資料由 server component 載入後傳進來，操作成功後呼叫 router.refresh() 重新載入。
// 核對狀態只來自 verification_status，不讀內部狀態。鍵有沒有與別的組織重複，畫面看不出來（ADR-0028 決議 1）。
// 單位分頁列出同一個物件下自己組織的租賃單位，並可新增分租單位（ADR-0025 決議 13）。
// 顯示編碼不含建號，是畫面上識別單位的短編碼（決議 12）。頁首只有一顆 primary（新增分租單位），面板的按鈕都是 default。

import { useState, useTransition } from 'react';
import { App as AntApp, Button, Card, Descriptions, Flex, Tabs, Tag, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { DisplayCode } from '@/components/DisplayCode';
import OwnershipPanel from '@/components/OwnershipPanel';
import DetailPage from '@/components/page/DetailPage';
import NextStep from '@/components/page/NextStep';
import AnchorPanel from '@/components/property/AnchorPanel';
import CasesPanel from '@/components/property/CasesPanel';
import SubletModal from '@/components/property/SubletModal';
import UnitsPanel from '@/components/property/UnitsPanel';
import StatusTag from '@/components/StatusTag';
import { formatEquipmentItem } from '@/lib/equipment';
import { shortUlid } from '@/lib/pg/ulid';
import type { PropertyDetailData } from '@/lib/property-detail-load';
import { propertyNextStep } from '@/lib/property-next-step';
import { unitFullText } from '@/lib/properties/unit-display';
import { useRouter } from 'next/navigation';

function BasicPanel({ property }: Pick<PropertyDetailData, 'property'>) {
  return (
    <Descriptions
      column={1}
      size="small"
      bordered
      items={[
        { key: 'name', label: '名稱', children: property.name },
        { key: 'type', label: '型態', children: property.type },
        { key: 'size', label: '坪數', children: property.size ?? '—' },
        { key: 'rent', label: '預設租金', children: property.default_rent != null ? `$${property.default_rent.toLocaleString('en-US')}` : '—' },
        {
          key: 'equipment',
          label: '設備',
          children: property.equipment.length ? (
            <Flex wrap gap="var(--space-xxs)">
              {property.equipment.map((e) => (
                <Tag key={e.name}>{formatEquipmentItem(e)}</Tag>
              ))}
            </Flex>
          ) : (
            '—'
          ),
        },
        { key: 'note', label: '備註', children: property.note || '—' },
      ]}
    />
  );
}

function PropertyDetailInner({ property, units, ownership, cases }: PropertyDetailData) {
  const router = useRouter();
  const [, startRefresh] = useTransition();
  const [subletOpen, setSubletOpen] = useState(false);
  const archived = Boolean(property.archived_at);
  const reload = () => startRefresh(() => router.refresh());

  const next = propertyNextStep({
    archived,
    hasKey: ownership.has_key,
    verificationStatus: property.verification_status,
    nodeStatus: ownership.node_status,
    messages: ownership.messages,
  });

  return (
    <>
      <DetailPage
        header={{
          title: property.name,
          tag: (
            <Flex align="center" gap="small">
              <StatusTag kind="propertyVerification" value={property.verification_status} />
              {archived && <Tag>已封存</Tag>}
            </Flex>
          ),
          extra: !archived && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setSubletOpen(true)}>
              新增分租單位
            </Button>
          ),
          back: { href: '/properties', label: '返回物件列表' },
        }}
        nextStep={<NextStep headline={next.headline} owner={next.owner} detail={next.detail} tone={next.tone} />}
        aside={
          <Card size="small" title="物件屬性">
            <Descriptions
              column={1}
              size="small"
              items={[
                { key: 'display-code', label: '顯示編碼', children: <DisplayCode code={property.unit?.display_code} /> },
                ...(property.unit
                  ? [
                      { key: 'unit', label: '單位', children: unitFullText(property.unit) },
                      ...(property.unit.floor ? [{ key: 'floor', label: '樓層', children: property.unit.floor }] : []),
                    ]
                  : []),
                { key: 'address', label: '地址', children: property.address },
                {
                  key: 'id',
                  label: '物件 ID 末碼',
                  children: (
                    <Typography.Text type="secondary" code title={property.id}>
                      {shortUlid(property.id)}
                    </Typography.Text>
                  ),
                },
              ]}
            />
          </Card>
        }
      >
        <CasesPanel cases={cases} />
        <Tabs
          items={[
            { key: 'basic', label: '基本資料', children: <BasicPanel property={property} /> },
            {
              key: 'anchor',
              label: '建號與核對',
              children: (
                <Flex vertical gap="large">
                  <AnchorPanel property={property} onChanged={reload} />
                  <OwnershipPanel ownership={ownership} archived={archived} onChanged={reload} />
                </Flex>
              ),
            },
            { key: 'units', label: '單位', children: <UnitsPanel currentId={property.id} units={units} /> },
          ]}
        />
      </DetailPage>
      <SubletModal
        property={property}
        open={subletOpen}
        onClose={() => setSubletOpen(false)}
        onCreated={() => {
          setSubletOpen(false);
          reload();
        }}
      />
    </>
  );
}

export default function PropertyDetail(props: PropertyDetailData) {
  return (
    <AntApp>
      <PropertyDetailInner {...props} />
    </AntApp>
  );
}
