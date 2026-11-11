'use client';

// 新增分租單位的表單（ADR-0025 決議 13，MIL-177 從物件詳情頁拆出）。房號只存標籤，單位後綴由平台發號。

import { useState } from 'react';
import { App as AntApp, Form, Input, Modal, Select, Typography } from 'antd';
import { PROPERTY_TYPES, type Property } from '@/lib/types';
import styles from './SubletModal.module.css';

interface SubletModalProps {
  property: Property;
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export default function SubletModal({ property, open, onClose, onCreated }: SubletModalProps) {
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
          <Select className={styles.typeSelect} options={PROPERTY_TYPES.map((t) => ({ value: t, label: t }))} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
