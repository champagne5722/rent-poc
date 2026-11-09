'use client';

// 委託標的清單編輯（MIL-74、P0-11）：租賃單位從物件多選，名稱與地址在加入時快照，
// 每列勾選委託範圍（收租、押金管理、修繕、點交）。B 線完成後，這裡改選產權錨點。
// 清單的檢核與文字在 src/lib/mandate-schedule，這裡只畫畫面。

import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Flex, Select, Table, Typography } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import {
  MANDATE_SCOPES,
  MANDATE_SCOPE_LABELS,
  mandateItemFromProperty,
  mandateItemsIssues,
  type MandateItem,
} from '@/lib/mandate-schedule';
import type { Property } from '@/lib/types';

interface Props {
  items: readonly MandateItem[];
  onChange: (next: MandateItem[]) => void;
  disabled?: boolean;
}

export default function MandateItemsEditor({ items, onChange, disabled }: Props) {
  const [properties, setProperties] = useState<Property[] | null>(null);

  useEffect(() => {
    fetch('/api/properties')
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((j) => setProperties(j.data ?? []))
      .catch(() => setProperties([]));
  }, []);

  // 多選控制「哪些租賃單位在清單內」。新加的列取物件當下的名稱與地址，已在清單的列保留原快照與範圍
  const pickProperties = (ids: string[]) => {
    onChange(
      ids.flatMap((id) => {
        const existing = items.find((item) => item.propertyId === id);
        if (existing) return [existing];
        const property = properties?.find((p) => String(p.id) === id);
        return property ? [mandateItemFromProperty(property)] : [];
      }),
    );
  };

  const setScopes = (propertyId: string, scopes: MandateItem['scopes']) =>
    onChange(items.map((item) => (item.propertyId === propertyId ? { ...item, scopes } : item)));

  const issues = mandateItemsIssues(items);

  return (
    <Flex vertical gap={12}>
      <Typography.Text strong>委託標的清單</Typography.Text>
      <Typography.Text type="secondary">
        從物件選出要委託管理的租賃單位，再逐列勾選委託範圍。名稱與地址在加入清單時快照，之後修改物件不影響這份合約。
      </Typography.Text>
      <Select
        mode="multiple"
        allowClear
        showSearch={{ optionFilterProp: 'label' }}
        disabled={disabled}
        loading={properties === null}
        placeholder="選擇租賃單位（可多選）"
        value={items.map((item) => item.propertyId)}
        onChange={pickProperties}
        options={(properties ?? []).map((p) => ({ value: String(p.id), label: `${p.name}（${p.address}）` }))}
        notFoundContent={properties?.length === 0 ? '還沒有物件，請先到物件頁新增' : undefined}
      />
      <Table<MandateItem>
        size="middle"
        rowKey="propertyId"
        dataSource={[...items]}
        pagination={false}
        locale={{ emptyText: '尚未加入租賃單位。從上方的物件選擇。' }}
        columns={[
          {
            title: '租賃單位',
            render: (_, item) => (
              <Flex vertical>
                <Typography.Text>{item.propertyName}</Typography.Text>
                <Typography.Text type="secondary">{item.propertyAddress}</Typography.Text>
              </Flex>
            ),
          },
          {
            title: '委託範圍',
            width: 340,
            render: (_, item) => (
              <Checkbox.Group
                disabled={disabled}
                value={item.scopes}
                onChange={(values) =>
                  setScopes(
                    item.propertyId,
                    MANDATE_SCOPES.filter((s) => values.includes(s)),
                  )
                }
                options={MANDATE_SCOPES.map((s) => ({ value: s, label: MANDATE_SCOPE_LABELS[s] }))}
              />
            ),
          },
          {
            title: '',
            width: 56,
            render: (_, item) => (
              <Button
                type="text"
                danger
                disabled={disabled}
                aria-label={`移除${item.propertyName}`}
                icon={<DeleteOutlined />}
                onClick={() => onChange(items.filter((i) => i.propertyId !== item.propertyId))}
              />
            ),
          },
        ]}
      />
      {items.length > 0 && issues.length > 0 && (
        <Alert
          type="warning"
          showIcon
          title="委託標的清單還有未完成的項目"
          description={
            <Flex vertical>
              {issues.map((issue) => (
                <Typography.Text key={issue}>{issue}</Typography.Text>
              ))}
            </Flex>
          }
        />
      )}
    </Flex>
  );
}
