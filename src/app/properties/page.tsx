'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  App as AntApp,
  Button,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  theme,
  Typography,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { EquipmentItem, EquipmentVocabularyItem, Property, PropertyVerificationStatus } from '@/lib/types';
import { PROPERTY_TYPES } from '@/lib/types';
import { formatEquipmentItem } from '@/lib/equipment';
import { AnchorSection } from '@/components/AnchorFields';
import { DisplayCode } from '@/components/DisplayCode';
import StatusTag from '@/components/StatusTag';
import { anchorSummary, registeredMessage } from '@/lib/properties/anchor-display';
import { buildAnchorPayload } from '@/lib/properties/anchor-form';
import { flattenPropertyGroups } from '@/lib/properties/group-rows';
import { unitShortText } from '@/lib/properties/unit-display';

interface EquipmentPickerProps {
  vocabulary: EquipmentVocabularyItem[];
  /** 由 Form.Item 注入：目前物件的設備清單 */
  value?: EquipmentItem[];
  onChange?: (value: EquipmentItem[]) => void;
  /** 就地新增自訂項目，回傳是否成功；成功後由本元件直接勾選 */
  onAddCustom: (name: string) => Promise<boolean>;
}

// 設備清單編輯器（ADR-0008）：從設備詞彙庫勾項目並設定數量，可就地新增自訂項目。
// 受控元件，value／onChange 由 Form.Item 接手。
function EquipmentPicker({ vocabulary, value = [], onChange, onAddCustom }: EquipmentPickerProps) {
  const [customName, setCustomName] = useState('');
  const [adding, setAdding] = useState(false);

  // 詞彙庫沒有但清單裡有的名稱照樣列出來（例如詞彙庫載入前就開了編輯），不讓既有設備憑空消失
  const names = [...vocabulary.map((v) => v.name)];
  for (const item of value) if (!names.includes(item.name)) names.push(item.name);

  const selectedOf = (name: string) => value.find((i) => i.name === name);

  const toggle = (name: string, checked: boolean) => {
    onChange?.(checked ? [...value, { name, quantity: 1 }] : value.filter((i) => i.name !== name));
  };

  const setQuantity = (name: string, quantity: number | null) => {
    onChange?.(value.map((i) => (i.name === name ? { ...i, quantity: quantity ?? 1 } : i)));
  };

  const addCustom = async () => {
    const name = customName.trim();
    if (!name) return;
    setAdding(true);
    const ok = await onAddCustom(name);
    setAdding(false);
    if (!ok) return;
    setCustomName('');
    if (!selectedOf(name)) onChange?.([...value, { name, quantity: 1 }]);
  };

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
        {names.map((name) => {
          const selected = selectedOf(name);
          return (
            <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 150 }}>
              <Checkbox checked={!!selected} onChange={(e) => toggle(name, e.target.checked)}>
                {name}
              </Checkbox>
              {selected && (
                <InputNumber
                  size="small"
                  min={1}
                  precision={0}
                  style={{ width: 64 }}
                  value={selected.quantity}
                  onChange={(v) => setQuantity(name, v)}
                />
              )}
            </div>
          );
        })}
      </div>
      <Space.Compact style={{ marginTop: 8, width: 300 }}>
        <Input
          size="small"
          placeholder="詞彙庫沒有？輸入名稱新增"
          value={customName}
          onChange={(e) => setCustomName(e.target.value)}
          onPressEnter={(e) => {
            e.preventDefault();
            addCustom();
          }}
        />
        <Button size="small" loading={adding} onClick={addCustom}>
          新增項目
        </Button>
      </Space.Compact>
    </>
  );
}

function PropertiesPage() {
  const { message } = AntApp.useApp();
  const router = useRouter();
  const { token } = theme.useToken();
  const [items, setItems] = useState<Property[]>([]);
  const [vocabulary, setVocabulary] = useState<EquipmentVocabularyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Property | 'new' | null>(null);
  // 有案件（或未掛案件的合約）的物件刪除時改為封存（MIL-145）。封存的物件預設不列出，開關打開才看得到
  const [showArchived, setShowArchived] = useState(false);
  const [form] = Form.useForm();
  const archivedCount = useMemo(() => items.filter((p) => p.archived_at).length, [items]);
  const visibleItems = useMemo(() => (showArchived ? items : items.filter((p) => !p.archived_at)), [items, showArchived]);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch('/api/properties?group=object');
    const json = await res.json();
    setItems(flattenPropertyGroups(json.data));
    setLoading(false);
  }, []);

  const loadVocabulary = useCallback(async () => {
    const res = await fetch('/api/equipment-vocabulary');
    const json = await res.json();
    setVocabulary(json.data ?? []);
  }, []);

  useEffect(() => {
    load();
    loadVocabulary();
  }, [load, loadVocabulary]);

  // 新增自訂項目：成功後刷新詞彙庫，讓其他物件也選得到
  const addCustomEquipment = async (name: string) => {
    const res = await fetch('/api/equipment-vocabulary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      message.error((await res.json()).error ?? '新增設備項目失敗');
      return false;
    }
    await loadVocabulary();
    return true;
  };

  const openEditor = (target: Property | 'new') => {
    setEditing(target);
    if (target === 'new') {
      form.resetFields();
    } else {
      // 建號不在這裡改：補建號與修正建號在詳情頁
      const { anchor: _anchor, unit: _unit, archived_at: _archivedAt, ...rest } = target;
      void _anchor;
      void _unit;
      void _archivedAt;
      form.setFieldsValue(rest);
    }
  };

  const save = async () => {
    const values = await form.validateFields();
    const isNew = editing === 'new';
    // 只有建立時送建號；修改物件不動建號
    const payload = isNew ? { ...values, anchor: buildAnchorPayload(values.anchor) } : { ...values, anchor: undefined };
    const res = await fetch(isNew ? '/api/properties' : `/api/properties/${(editing as Property).id}`, {
      method: isNew ? 'POST' : 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      message.error((await res.json()).error ?? '儲存失敗');
      return;
    }
    const json = (await res.json().catch(() => ({}))) as { data?: { id?: string; existing?: boolean; verification_status?: PropertyVerificationStatus } };
    setEditing(null);
    if (isNew && json.data?.existing && json.data.id) {
      // 這個鍵已由自己的組織登錄（MIL-144）：沒有建新物件，帶使用者到既有的那筆
      message.info('這個物件你已經登錄過，已帶你到既有的物件');
      router.push(`/properties/${json.data.id}`);
      return;
    }
    // 鍵有沒有與別的組織重複，訊息都一樣（ADR-0028 決議 2）
    message.success(isNew ? registeredMessage(json.data?.verification_status ?? 'pending_verification') : '物件已更新');
    load();
  };

  const remove = async (id: string) => {
    const res = await fetch(`/api/properties/${id}`, { method: 'DELETE' });
    const json = await res.json();
    if (!res.ok) {
      message.error(json.error ?? '刪除失敗');
    } else if (json.data.result === 'archived') {
      message.success('物件已有案件或合約，已改為封存');
    } else {
      message.success('物件已刪除');
    }
    load();
  };

  const createContract = async (propertyId: string) => {
    const res = await fetch('/api/contracts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ property_id: propertyId }),
    });
    const json = await res.json();
    if (!res.ok) {
      message.error(json.error ?? '建立合約失敗');
      return;
    }
    // 從物件建約＝wizard 第①步已完成，直接進 wizard 續走後續步驟
    router.push(`/contracts/${json.data.id}/edit`);
  };

  return (
    <>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          物件
        </Typography.Title>
        <Space size="middle">
          {archivedCount > 0 && (
            <Space size="small">
              <Switch size="small" checked={showArchived} onChange={setShowArchived} aria-label="顯示已封存的物件" />
              <Typography.Text type="secondary">顯示已封存（{archivedCount}）</Typography.Text>
            </Space>
          )}
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor('new')}>
            新增物件
          </Button>
        </Space>
      </Space>
      <Table<Property>
        rowKey="id"
        loading={loading}
        dataSource={visibleItems}
        pagination={false}
        // 欄寬明確，1440 寬、側欄展開時不必橫向捲動；視窗更窄時才捲動，操作欄固定在右側（比照合約列表）
        scroll={{ x: 1000 }}
        columns={[
          {
            // 租賃單位的顯示編碼（GLOSSARY「顯示編碼」），不含建號，口頭溝通與客服對照用。不保證唯一
            title: '顯示編碼',
            width: 128,
            render: (_, record) => <DisplayCode code={record.unit?.display_code} />,
          },
          {
            title: '名稱',
            dataIndex: 'name',
            width: 100,
            render: (name: string, record) => (
              <Space size="small">
                <Link href={`/properties/${record.id}`} style={{ color: token.colorPrimary }}>
                  {name}
                </Link>
                {record.archived_at && <Tag>已封存</Tag>}
              </Space>
            ),
          },
          {
            title: '單位',
            width: 60,
            render: (_, record) => (record.unit ? unitShortText(record.unit) : '—'),
          },
          { title: '地址', dataIndex: 'address', width: 116 },
          { title: '建號', dataIndex: 'anchor', width: 126, render: (_: unknown, record) => anchorSummary(record.anchor) },
          {
            title: '核對狀態',
            width: 132,
            render: (_, record) => <StatusTag kind="propertyVerification" value={record.verification_status} />,
          },
          { title: '型態', dataIndex: 'type', width: 92 },
          { title: '坪數', dataIndex: 'size', width: 60, render: (v) => v ?? '—' },
          {
            title: '預設租金',
            dataIndex: 'default_rent',
            width: 100,
            render: (v) => (v != null ? `$${v.toLocaleString()}` : '—'),
          },
          {
            title: '設備',
            dataIndex: 'equipment',
            width: 60,
            render: (eq: EquipmentItem[]) =>
              eq.length ? (
                <>
                  {eq.map((e) => (
                    <Tag key={e.name}>{formatEquipmentItem(e)}</Tag>
                  ))}
                </>
              ) : (
                '—'
              ),
          },
          {
            // 操作欄放最右並固定，用文字連結，最常用的動作放第一個（docs/ui/composite-components.md）
            title: '操作',
            width: 190,
            fixed: 'right',
            render: (_, record) =>
              record.archived_at ? (
                <Typography.Text type="secondary">已封存，唯讀</Typography.Text>
              ) : (
                <Space size={0}>
                  <Button type="link" size="small" onClick={() => createContract(record.id)}>
                    建立合約
                  </Button>
                  <Button type="link" size="small" onClick={() => openEditor(record)}>
                    編輯
                  </Button>
                  <Popconfirm title="確定刪除此物件？" description="有案件或合約的物件會改為封存，不會刪除。" onConfirm={() => remove(record.id)}>
                    <Button type="link" size="small" danger>
                      刪除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
          },
        ]}
        locale={{ emptyText: '尚無物件，點右上角「新增物件」開始' }}
      />

      <Modal
        title={editing === 'new' ? '新增物件' : '編輯物件'}
        open={editing !== null}
        onOk={save}
        onCancel={() => setEditing(null)}
        okText="儲存"
        cancelText="取消"
        width={720}
        forceRender
      >
        <Form form={form} layout="vertical" initialValues={{ type: '整層住家', equipment: [] }}>
          <Form.Item name="name" label="物件名稱" rules={[{ required: true, message: '請輸入名稱' }]}>
            <Input placeholder="例：大安區溫馨兩房" />
          </Form.Item>
          <Form.Item name="address" label="完整地址" rules={[{ required: true, message: '請輸入地址' }]}>
            <Input placeholder="例：台北市大安區和平東路二段 100 號 3 樓" />
          </Form.Item>
          <Space size="large">
            <Form.Item name="type" label="型態">
              <Select style={{ width: 120 }} options={PROPERTY_TYPES.map((t) => ({ value: t, label: t }))} />
            </Form.Item>
            <Form.Item name="size" label="坪數">
              <InputNumber min={0} style={{ width: 100 }} />
            </Form.Item>
            <Form.Item name="default_rent" label="預設租金（元/月）">
              <InputNumber min={0} step={1000} style={{ width: 140 }} />
            </Form.Item>
          </Space>
          <Form.Item name="equipment" label="附屬設備">
            <EquipmentPicker vocabulary={vocabulary} onAddCustom={addCustomEquipment} />
          </Form.Item>
          <Form.Item name="note" label="備註">
            <Input.TextArea rows={2} />
          </Form.Item>
          {editing === 'new' ? (
            <AnchorSection form={form} />
          ) : (
            <Typography.Text type="secondary">建號在物件詳情頁查看與修正。</Typography.Text>
          )}
        </Form>
      </Modal>
    </>
  );
}

export default function Page() {
  return (
    <AntApp>
      <PropertiesPage />
    </AntApp>
  );
}
