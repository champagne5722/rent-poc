'use client';

import { useCallback, useEffect, useState } from 'react';
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
  Table,
  Tag,
  Typography,
} from 'antd';
import { PlusOutlined, FileAddOutlined } from '@ant-design/icons';
import { useRouter } from 'next/navigation';
import type { Property } from '@/lib/types';
import { EQUIPMENT_OPTIONS, PROPERTY_TYPES } from '@/lib/types';

function PropertiesPage() {
  const { message } = AntApp.useApp();
  const router = useRouter();
  const [items, setItems] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Property | 'new' | null>(null);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch('/api/properties');
    const json = await res.json();
    setItems(json.data);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openEditor = (target: Property | 'new') => {
    setEditing(target);
    if (target === 'new') {
      form.resetFields();
    } else {
      form.setFieldsValue(target);
    }
  };

  const save = async () => {
    const values = await form.validateFields();
    const isNew = editing === 'new';
    const res = await fetch(isNew ? '/api/properties' : `/api/properties/${(editing as Property).id}`, {
      method: isNew ? 'POST' : 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    });
    if (!res.ok) {
      message.error((await res.json()).error ?? '儲存失敗');
      return;
    }
    message.success(isNew ? '物件已建立' : '物件已更新');
    setEditing(null);
    load();
  };

  const remove = async (id: number) => {
    await fetch(`/api/properties/${id}`, { method: 'DELETE' });
    message.success('物件已刪除');
    load();
  };

  const createContract = async (propertyId: number) => {
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
    router.push(`/contracts/${json.data.id}`);
  };

  return (
    <>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          物件
        </Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor('new')}>
          新增物件
        </Button>
      </Space>
      <Table<Property>
        rowKey="id"
        loading={loading}
        dataSource={items}
        pagination={false}
        columns={[
          { title: '名稱', dataIndex: 'name' },
          { title: '地址', dataIndex: 'address' },
          { title: '型態', dataIndex: 'type', width: 100 },
          { title: '坪數', dataIndex: 'size', width: 80, render: (v) => v ?? '—' },
          {
            title: '預設租金',
            dataIndex: 'default_rent',
            width: 110,
            render: (v) => (v != null ? `$${v.toLocaleString()}` : '—'),
          },
          {
            title: '設備',
            dataIndex: 'equipment',
            render: (eq: string[]) =>
              eq.length ? (
                <>
                  {eq.map((e) => (
                    <Tag key={e}>{e}</Tag>
                  ))}
                </>
              ) : (
                '—'
              ),
          },
          {
            title: '操作',
            width: 240,
            render: (_, record) => (
              <Space>
                <Button size="small" icon={<FileAddOutlined />} onClick={() => createContract(record.id)}>
                  建立合約
                </Button>
                <Button size="small" onClick={() => openEditor(record)}>
                  編輯
                </Button>
                <Popconfirm title="確定刪除此物件？" onConfirm={() => remove(record.id)}>
                  <Button size="small" danger>
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
            <Checkbox.Group options={EQUIPMENT_OPTIONS.map((e) => ({ value: e, label: e }))} />
          </Form.Item>
          <Form.Item name="note" label="備註">
            <Input.TextArea rows={2} />
          </Form.Item>
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
