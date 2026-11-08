'use client';

// 物件詳情頁（MIL-143、MIL-145）：分頁型版面，三個分頁：基本資料／產權／單位。
// 產權分頁顯示錨點狀態與鍵；待驗證的錨點有「補建號」。已建號的鍵不在這裡改，要更正由平台營運者處理（ADR-0025 決議 6）。
// 單位分頁列出同一產權下自己組織的單位，並可新增分租單位（ADR-0025 決議 13）。
// 顯示編碼不含建號，是畫面上識別單位的短編碼（決議 12）。

import { use, useEffect, useState } from 'react';
import { Alert, App as AntApp, Button, Descriptions, Empty, Flex, Form, Input, Modal, Select, Space, Spin, Table, Tabs, Tag, theme, Typography } from 'antd';
import { ArrowLeftOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import Link from 'next/link';
import { AnchorKeyFields } from '@/components/AnchorFields';
import { DisplayCode } from '@/components/DisplayCode';
import { shortUlid } from '@/lib/pg/ulid';
import { unitFullText } from '@/lib/properties/unit-display';
import { ANCHOR_STATUS_COLORS, ANCHOR_STATUS_LABELS, anchorKeyText, anchorLocationText } from '@/lib/properties/anchor-display';
import { buildAnchorPayload } from '@/lib/properties/anchor-form';
import { formatEquipmentItem } from '@/lib/equipment';
import type { Property, SiblingUnit } from '@/lib/types';
import { PROPERTY_TYPES } from '@/lib/types';

function AnchorPanel({ property, onKeyed }: { property: Property; onKeyed: () => void }) {
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
      onKeyed();
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
            <Button icon={<EditOutlined />} onClick={() => setOpen(true)}>
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
        { key: 'display-code', label: '顯示編碼', children: <DisplayCode code={property.unit?.display_code} /> },
        ...(property.unit
          ? [
              { key: 'unit', label: '單位', children: unitFullText(property.unit) },
              ...(property.unit.floor ? [{ key: 'floor', label: '樓層', children: property.unit.floor }] : []),
            ]
          : []),
        {
          key: 'id',
          label: '物件 ID 末碼',
          children: (
            <Typography.Text type="secondary" code title={property.id}>
              {shortUlid(property.id)}
            </Typography.Text>
          ),
        },
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

/** 同一產權下自己組織的單位。目前這個物件的列標示「目前」。 */
function UnitsPanel({ property, reloadToken }: { property: Property; reloadToken: number }) {
  const { token } = theme.useToken();
  const [units, setUnits] = useState<SiblingUnit[] | null>(null);

  useEffect(() => {
    let stale = false;
    void (async () => {
      const res = await fetch(`/api/properties/${property.id}/sublet-units`);
      const json = res.ok ? await res.json() : null;
      if (!stale) setUnits(json?.data ?? []);
    })();
    return () => {
      stale = true;
    };
  }, [property.id, reloadToken]);

  return (
    <Table<SiblingUnit>
      rowKey="property_id"
      size="middle"
      loading={units === null}
      dataSource={units ?? []}
      pagination={false}
      scroll={{ x: 'max-content' }}
      locale={{ emptyText: '同一產權下沒有其他單位' }}
      columns={[
        { title: '顯示編碼', width: 130, render: (_, u) => <DisplayCode code={u.display_code} /> },
        { title: '單位', width: 160, render: (_, u) => unitFullText(u) },
        { title: '樓層', dataIndex: 'floor', width: 80, render: (v: string | null) => v ?? '—' },
        {
          title: '物件',
          render: (_, u) =>
            u.property_id === property.id ? (
              <Space size="small">
                {u.name}
                <Tag>目前</Tag>
              </Space>
            ) : (
              <Link href={`/properties/${u.property_id}`} style={{ color: token.colorPrimary }}>
                {u.name}
              </Link>
            ),
        },
        { title: '狀態', width: 100, render: (_, u) => (u.archived_at ? <Tag>已封存</Tag> : <Tag color="success">使用中</Tag>) },
      ]}
    />
  );
}

/** 新增分租單位的表單（ADR-0025 決議 13）。房號只存標籤，單位後綴由平台發號。 */
function SubletModal({
  property,
  open,
  onClose,
  onCreated,
}: {
  property: Property;
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { message, modal } = AntApp.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  const send = async (confirmed: boolean): Promise<void> => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const res = await fetch(`/api/properties/${property.id}/sublet-units`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...values, confirmed }),
      });
      const json = await res.json();
      // 整戶仍在租期內：先請使用者確認，確認後帶 confirmed 再送一次（P0-06 AC4）
      if (res.status === 409 && json.code === 'whole_unit_active_lease') {
        modal.confirm({
          title: '整戶仍在租期內',
          content: '這個產權的整戶有已完成且租期未屆滿的租賃合約。仍要新增分租單位嗎？',
          okText: '仍要新增',
          cancelText: '取消',
          onOk: () => send(true),
        });
        return;
      }
      if (!res.ok) {
        message.error(json.error ?? '新增分租單位失敗');
        return;
      }
      message.success(`已新增分租單位，後綴 ${json.data.suffix}`);
      form.resetFields();
      onCreated();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="新增分租單位"
      open={open}
      onOk={() => void send(false)}
      confirmLoading={saving}
      onCancel={onClose}
      okText="新增"
      cancelText="取消"
      destroyOnHidden
    >
      <Form form={form} layout="vertical" initialValues={{ type: '套房' }}>
        <Typography.Paragraph type="secondary">
          新單位與「{property.name}」在同一個產權下。單位後綴由平台發號，房號只是標籤，之後改房號不會改後綴。
        </Typography.Paragraph>
        <Form.Item name="label" label="房號" rules={[{ required: true, whitespace: true, message: '請輸入房號' }, { max: 40, message: '房號不得超過 40 個字' }]}>
          <Input placeholder="例：301" />
        </Form.Item>
        <Form.Item name="floor" label="樓層" rules={[{ max: 20, message: '樓層不得超過 20 個字' }]}>
          <Input placeholder="例：3F" />
        </Form.Item>
        <Form.Item name="name" label="物件名稱" extra="沒填時用「物件名稱 加 房號」。">
          <Input placeholder={`${property.name} 房號`} />
        </Form.Item>
        <Form.Item name="type" label="型態">
          <Select style={{ width: 120 }} options={PROPERTY_TYPES.map((t) => ({ value: t, label: t }))} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function PropertyDetail({ id }: { id: string }) {
  const { token } = theme.useToken();
  const [property, setProperty] = useState<Property | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [reloadToken, setReloadToken] = useState(0);
  const [subletOpen, setSubletOpen] = useState(false);

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
  }, [id, reloadToken]);

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

  const reload = () => setReloadToken((n) => n + 1);

  return (
    <Flex vertical gap="large">
      <Flex vertical gap="small">
        <Link href="/properties" style={{ color: token.colorPrimary }}>
          <ArrowLeftOutlined /> 物件列表
        </Link>
        <Flex justify="space-between" align="center" wrap gap="small">
          <Flex align="center" gap="small" wrap>
            <Typography.Title level={4} style={{ margin: 0 }}>
              {property.name}
            </Typography.Title>
            <DisplayCode code={property.unit?.display_code} />
            {property.archived_at && <Tag>已封存</Tag>}
          </Flex>
          {!property.archived_at && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setSubletOpen(true)}>
              新增分租單位
            </Button>
          )}
        </Flex>
        {property.archived_at && (
          <Alert type="info" showIcon title="這個物件已封存" description="物件有合約，無法刪除，已改為封存。封存的物件唯讀，不能編輯、建合約或新增分租單位。" />
        )}
      </Flex>
      <Tabs
        items={[
          { key: 'basic', label: '基本資料', children: <BasicPanel property={property} /> },
          { key: 'anchor', label: '產權', children: <AnchorPanel property={property} onKeyed={reload} /> },
          { key: 'units', label: '單位', children: <UnitsPanel property={property} reloadToken={reloadToken} /> },
        ]}
      />
      <SubletModal
        property={property}
        open={subletOpen}
        onClose={() => setSubletOpen(false)}
        onCreated={() => {
          setSubletOpen(false);
          reload();
        }}
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
