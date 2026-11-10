'use client';

// 物件詳情頁（MIL-143、MIL-145、MIL-196）：分頁型版面，三個分頁：基本資料／建號與核對／單位。
// 建號與核對分頁顯示核對狀態與使用者填的建號。物件通過文件核對前，使用者能補建號與修正建號（ADR-0028 決議 9）。
// 核對狀態只來自 verification_status，不讀內部狀態。鍵有沒有與別的組織重複，畫面看不出來（ADR-0028 決議 1）。
// 單位分頁列出同一個物件下自己組織的租賃單位，並可新增分租單位（ADR-0025 決議 13）。
// 顯示編碼不含建號，是畫面上識別單位的短編碼（決議 12）。

import { use, useEffect, useState } from 'react';
import { Alert, App as AntApp, Button, Descriptions, Empty, Flex, Form, Input, Modal, Select, Space, Spin, Table, Tabs, Tag, theme, Typography } from 'antd';
import { ArrowLeftOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AnchorKeyFields } from '@/components/AnchorFields';
import { DisplayCode } from '@/components/DisplayCode';
import OwnershipPanel from '@/components/OwnershipPanel';
import StatusTag from '@/components/StatusTag';
import { REKEY_REVIEW_MESSAGE } from '@/lib/ownership/messages';
import { shortUlid } from '@/lib/pg/ulid';
import { unitFullText } from '@/lib/properties/unit-display';
import { anchorKeyText, anchorLocationText, registeredMessage } from '@/lib/properties/anchor-display';
import { buildAnchorPayload } from '@/lib/properties/anchor-form';
import { formatEquipmentItem } from '@/lib/equipment';
import type { Property, PropertyVerificationStatus, SiblingUnit } from '@/lib/types';
import { PROPERTY_TYPES } from '@/lib/types';

function AnchorPanel({ property, onKeyed }: { property: Property; onKeyed: () => void }) {
  const { message } = AntApp.useApp();
  const router = useRouter();
  const [form] = Form.useForm();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const anchor = property.anchor;

  if (!anchor) return <Empty description="讀不到這個物件的建號資料" />;

  // 沒有填建號的舊資料：補建號。已有建號：修正建號。兩者呼叫同一個 API，回應相同
  const hasKey = anchor.building_no !== null;
  const editLabel = hasKey ? '修正建號' : '補建號';

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
        message.error(json.error ?? `${editLabel}失敗`);
        return;
      }
      setOpen(false);
      form.resetFields();
      if (json.data?.existing) {
        // 這個鍵已由自己的組織登錄（MIL-144）：這個物件維持原樣，帶使用者到既有的物件
        message.info('這個物件你已經登錄過，已帶你到既有的物件');
        router.push(`/properties/${json.data.id}`);
        return;
      }
      if (json.data?.change_requested) {
        // 物件已通過核對：鍵維持原樣，修正改送審核台（MIL-201）
        message.info(json.data.message ?? REKEY_REVIEW_MESSAGE);
        onKeyed();
        return;
      }
      message.success(registeredMessage((json.data?.verification_status ?? 'pending_verification') as PropertyVerificationStatus));
      onKeyed();
    } finally {
      setSaving(false);
    }
  };

  const coordinates = anchor.latitude != null && anchor.longitude != null ? `${anchor.latitude}, ${anchor.longitude}` : '—';
  // 修正時帶入目前的建號。建號補零的部分不顯示，分號 000 視為沒有分號
  const initialKey = hasKey
    ? {
        city: anchor.city_code ?? undefined,
        town: anchor.town_code ?? undefined,
        section: anchor.section_code ?? undefined,
        buildingNo: String(Number(anchor.building_no)),
        subNo: anchor.sub_no && anchor.sub_no !== '000' ? String(Number(anchor.sub_no)) : '',
      }
    : undefined;

  return (
    <Flex vertical gap="middle">
      {!hasKey && !property.archived_at && (
        <Alert
          type="warning"
          showIcon
          title="這個物件還沒有填建號"
          description="補上建號後，平台才能核對文件。"
          action={
            <Button icon={<EditOutlined />} onClick={() => setOpen(true)}>
              {editLabel}
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
            label: '核對狀態',
            children: <StatusTag kind="propertyVerification" value={property.verification_status} />,
          },
          { key: 'address', label: '門牌', children: property.address },
          { key: 'location', label: '段小段', children: anchorLocationText(anchor) ?? '—' },
          { key: 'building', label: '建號', children: anchorKeyText(anchor) ?? '—' },
          { key: 'coordinates', label: '座標', children: coordinates },
        ]}
      />
      {hasKey && !property.archived_at && (
        <Flex align="center" gap="small" wrap>
          <Button icon={<EditOutlined />} onClick={() => setOpen(true)}>
            {editLabel}
          </Button>
          <Typography.Text type="secondary">
            建號填錯時可以修正。文件正在核對時不能修正，物件已核對後修正建號需要平台審核。
          </Typography.Text>
        </Flex>
      )}

      <Modal
        title={editLabel}
        open={open}
        onOk={() => void submit()}
        confirmLoading={saving}
        onCancel={() => setOpen(false)}
        okText="儲存"
        cancelText="取消"
        width={720}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" initialValues={{ key: initialKey }}>
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

/** 同一個物件下自己組織的租賃單位。目前這個營運資料的列標示「目前」。 */
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
      locale={{ emptyText: '同一個物件下沒有其他租賃單位' }}
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
          content: '這個物件的整戶有已完成且租期未屆滿的租賃合約。仍要新增分租單位嗎？',
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
          新單位與「{property.name}」在同一個物件下。單位後綴由平台發號，房號只是標籤，之後改房號不會改後綴。
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
          <Alert type="info" showIcon title="這個物件已封存" description="物件有案件或合約，無法刪除，已改為封存。封存的物件唯讀，不能編輯、建合約或新增分租單位。" />
        )}
      </Flex>
      <Tabs
        items={[
          { key: 'basic', label: '基本資料', children: <BasicPanel property={property} /> },
          {
            key: 'anchor',
            label: '建號與核對',
            children: (
              <Flex vertical gap="large">
                <AnchorPanel property={property} onKeyed={reload} />
                <OwnershipPanel propertyId={property.id} archived={Boolean(property.archived_at)} reloadToken={reloadToken} onChanged={reload} />
              </Flex>
            ),
          },
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
