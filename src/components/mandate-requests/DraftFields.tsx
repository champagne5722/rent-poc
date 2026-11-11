'use client';

import { Flex, Form, Input, InputNumber, Select } from 'antd';
import type { FormInstance } from 'antd';
import { AnchorSection } from '@/components/AnchorFields';
import { PROPERTY_TYPES } from '@/lib/types';
import styles from './mandate-requests.module.css';

// 業者代填的物件資料欄位（MIL-206 畫面段）。欄位與物件登錄表單（PropertyEditorModal）相同：名稱、地址、型態、坪數、預設租金、備註、建號。
// 附屬設備不在這裡填：設備詞彙庫屬於屋主的組織，屋主確認後自己補。
// 放在呼叫端的 Form 裡，欄位路徑在 Form 的根，建號是 ['anchor', ...]。

export default function DraftFields({ form }: { form: FormInstance }) {
  return (
    <>
      <Form.Item name="name" label="物件名稱" rules={[{ required: true, whitespace: true, message: '請輸入名稱' }]}>
        <Input placeholder="例：大安區溫馨兩房" autoComplete="off" />
      </Form.Item>
      <Form.Item name="address" label="完整地址" rules={[{ required: true, whitespace: true, message: '請輸入地址' }]}>
        <Input placeholder="例：台北市大安區和平東路二段 100 號 3 樓" autoComplete="off" />
      </Form.Item>
      <Flex gap="large" wrap>
        <Form.Item name="type" label="型態">
          <Select className={styles.typeSelect} options={PROPERTY_TYPES.map((t) => ({ value: t, label: t }))} />
        </Form.Item>
        <Form.Item name="size" label="坪數">
          <InputNumber min={0} className={styles.sizeInput} />
        </Form.Item>
        <Form.Item name="default_rent" label="預設租金（元/月）">
          <InputNumber min={0} step={1000} className={styles.rentInput} />
        </Form.Item>
      </Flex>
      <Form.Item name="note" label="備註">
        <Input.TextArea rows={2} />
      </Form.Item>
      <AnchorSection form={form} />
    </>
  );
}
