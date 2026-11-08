'use client';

// 物件詳情頁（MIL-143）：分頁型版面，目前兩個分頁：基本資料／產權。
// 產權分頁顯示錨點狀態與鍵；待驗證的錨點有「補建號」。已建號的鍵不在這裡改，要更正由平台營運者處理（ADR-0025 決議 6）。

import { use, useEffect, useState } from 'react';
import { Alert, App as AntApp, Button, Descriptions, Empty, Flex, Form, Modal, Spin, Tabs, Tag, theme, Typography } from 'antd';
import { ArrowLeftOutlined, EditOutlined } from '@ant-design/icons';
import Link from 'next/link';
import { AnchorKeyFields } from '@/components/AnchorFields';
import { ANCHOR_STATUS_COLORS, ANCHOR_STATUS_LABELS, anchorKeyText, anchorLocationText } from '@/lib/properties/anchor-display';
import { buildAnchorPayload } from '@/lib/properties/anchor-form';
import { formatEquipmentItem } from '@/lib/equipment';
import type { Property, PropertyAnchor } from '@/lib/types';

function AnchorPanel({ property, onKeyed }: { property: Property; onKeyed: (anchor: PropertyAnchor) => void }) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const anchor = property.anchor;

  if (!anchor) return <Empty description="讀不到這個物件的產權資料" />;

  const submit = async () => {
    const values = await form.validateFields();
    const { key } = buildAnchorPayload({ key: values.key });
    setSaving(true);
    try {
      const res = await fetch(`/api/properties/${property.id}/anchor-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(key),
      });
      const json = await res.json();
      if (!res.ok) {
        message.error(json.error ?? '補建號失敗');
        return;
      }
      message.success('已補上建號');
      setOpen(false);
      form.resetFields();
      onKeyed(json.data.anchor);
    } finally {
      setSaving(false);
    }
  };

  const keyed = anchor.status === 'keyed';
  const coordinates = anchor.latitude != null && anchor.longitude != null ? `${anchor.latitude}, ${anchor.longitude}` : '—';

  return (
    <Flex vertical gap="middle">
      {anchor.status === 'pending_verification' && (
        <Alert
          type="warning"
          showIcon
          title="這個物件還沒有建號"
          description="目前只靠門牌登錄。補上建號後，產權狀態會變成「已建號」。"
          action={
            <Button type="primary" icon={<EditOutlined />} onClick={() => setOpen(true)}>
              補建號
            </Button>
          }
        />
      )}
      <Descriptions
        column={1}
        size="small"
        bordered
        items={[
          {
            key: 'status',
            label: '產權狀態',
            children: (
              <Tag color={ANCHOR_STATUS_COLORS[anchor.status]}>{ANCHOR_STATUS_LABELS[anchor.status]}</Tag>
            ),
          },
          { key: 'address', label: '門牌', children: property.address },
          { key: 'location', label: '段小段', children: anchorLocationText(anchor) ?? '—' },
          { key: 'building', label: '建號', children: anchorKeyText(anchor) ?? '—' },
          { key: 'coordinates', label: '座標', children: coordinates },
        ]}
      />
      {keyed && <Typography.Text type="secondary">已建號的鍵填錯時，請聯絡平台申請修正。</Typography.Text>}

      <Modal
        title="補建號"
        open={open}
        onOk={() => void submit()}
        confirmLoading={saving}
        onCancel={() => setOpen(false)}
        okText="儲存"
        cancelText="取消"
        width={720}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <AnchorKeyFields form={form} prefix={['key']} />
        </Form>
      </Modal>
    </Flex>
  );
}

function BasicPanel({ property }: { property: Property }) {
  return (
    <Descriptions
      column={1}
      size="small"
      bordered
      items={[
        { key: 'name', label: '名稱', children: property.name },
        { key: 'address', label: '地址', children: property.address },
        { key: 'type', label: '型態', children: property.type },
        { key: 'size', label: '坪數', children: property.size ?? '—' },
        { key: 'rent', label: '預設租金', children: property.default_rent != null ? `$${property.default_rent.toLocaleString()}` : '—' },
        {
          key: 'equipment',
          label: '設備',
          children: property.equipment.length ? property.equipment.map((e) => <Tag key={e.name}>{formatEquipmentItem(e)}</Tag>) : '—',
        },
        { key: 'note', label: '備註', children: property.note || '—' },
      ]}
    />
  );
}

function PropertyDetail({ id }: { id: string }) {
  const { token } = theme.useToken();
  const [property, setProperty] = useState<Property | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');

  useEffect(() => {
    let stale = false;
    void (async () => {
      const res = await fetch(`/api/properties/${id}`);
      const json = res.ok ? await res.json() : null;
      if (stale) return;
      setProperty(json?.data ?? null);
      setState(json ? 'ready' : 'missing');
    })();
    return () => {
      stale = true;
    };
  }, [id]);

  if (state === 'loading') return <Spin />;
  if (state === 'missing' || !property) {
    return (
      <Empty description="找不到這個物件">
        <Link href="/properties" style={{ color: token.colorPrimary }}>
          回物件列表
        </Link>
      </Empty>
    );
  }

  return (
    <Flex vertical gap="large">
      <Flex vertical gap="small">
        <Link href="/properties" style={{ color: token.colorPrimary }}>
          <ArrowLeftOutlined /> 物件列表
        </Link>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {property.name}
        </Typography.Title>
      </Flex>
      <Tabs
        items={[
          { key: 'basic', label: '基本資料', children: <BasicPanel property={property} /> },
          {
            key: 'anchor',
            label: '產權',
            children: <AnchorPanel property={property} onKeyed={(anchor) => setProperty({ ...property, anchor })} />,
          },
        ]}
      />
    </Flex>
  );
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <AntApp>
      <PropertyDetail id={id} />
    </AntApp>
  );
}
