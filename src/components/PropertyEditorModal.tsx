'use client';

import { useCallback, useMemo, useState } from 'react';
import { App as AntApp, Button, Checkbox, Flex, Form, Input, InputNumber, Modal, Select, Space, Typography } from 'antd';
import { useRouter } from 'next/navigation';
import type { EquipmentItem, EquipmentVocabularyItem, PropertyGroupUnit, PropertyVerificationStatus } from '@/lib/types';
import { PROPERTY_TYPES } from '@/lib/types';
import { AnchorSection } from '@/components/AnchorFields';
import { registeredMessage } from '@/lib/properties/anchor-display';
import { buildAnchorPayload } from '@/lib/properties/anchor-form';
import styles from './PropertyEditorModal.module.css';

// 物件的新增與編輯表單（MIL-177）。從物件列表拆出來：列表只管列與篩選，表單的狀態與 API 呼叫都在這裡。
// 成功後呼叫 onSaved，由列表請 server component 重新載入。建號只在建立時填，修正建號在物件詳情頁。

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
      <Flex wrap gap="var(--space-xxs) var(--space-sm)">
        {names.map((name) => {
          const selected = selectedOf(name);
          return (
            <div key={name} className={styles.equipmentItem}>
              <Checkbox checked={!!selected} onChange={(e) => toggle(name, e.target.checked)}>
                {name}
              </Checkbox>
              {selected && (
                <InputNumber
                  size="small"
                  min={1}
                  precision={0}
                  className={styles.quantity}
                  value={selected.quantity}
                  onChange={(v) => setQuantity(name, v)}
                  aria-label={`${name}的數量`}
                />
              )}
            </div>
          );
        })}
      </Flex>
      <Space.Compact className={styles.customAdd}>
        <Input
          size="small"
          placeholder="詞彙庫沒有？輸入名稱新增"
          value={customName}
          onChange={(e) => setCustomName(e.target.value)}
          onPressEnter={(e) => {
            e.preventDefault();
            void addCustom();
          }}
        />
        <Button size="small" loading={adding} onClick={() => void addCustom()}>
          新增項目
        </Button>
      </Space.Compact>
    </>
  );
}

export interface PropertyEditorModalProps {
  /** 要編輯的單位，或 'new' 表示新增物件。null 表示關閉。 */
  editing: PropertyGroupUnit | 'new' | null;
  vocabulary: EquipmentVocabularyItem[];
  onClose: () => void;
  /** 儲存成功後呼叫，列表藉此重新載入。 */
  onSaved: () => void;
}

export default function PropertyEditorModal({ editing, vocabulary: initialVocabulary, onClose, onSaved }: PropertyEditorModalProps) {
  const { message } = AntApp.useApp();
  const router = useRouter();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  // 詞彙庫由 server component 載入。就地新增自訂項目後，在這裡重讀，讓表單馬上看得到
  const [vocabulary, setVocabulary] = useState(initialVocabulary);
  const [lastInitial, setLastInitial] = useState(initialVocabulary);
  if (lastInitial !== initialVocabulary) {
    setLastInitial(initialVocabulary);
    setVocabulary(initialVocabulary);
  }

  const reloadVocabulary = useCallback(async () => {
    const res = await fetch('/api/equipment-vocabulary');
    const json = await res.json();
    setVocabulary(json.data ?? []);
  }, []);

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
    await reloadVocabulary();
    return true;
  };

  // 表單每次開啟都重新掛載，初始值是目前要編輯的單位。建號不在這裡改：補建號與修正建號在詳情頁。
  // 不用 Modal 的 forceRender：它會在 hydration 時渲染 server 沒有輸出的 portal，造成 hydration 不一致（MIL-190）
  const initialValues = useMemo(() => {
    if (editing === null || editing === 'new') return { type: '整層住家', equipment: [] };
    const { unit: _unit, archived_at: _archivedAt, ...rest } = editing;
    void _unit;
    void _archivedAt;
    return rest;
  }, [editing]);

  const save = async () => {
    const values = await form.validateFields();
    const isNew = editing === 'new';
    // 只有建立時送建號；修改物件不動建號
    const payload = isNew ? { ...values, anchor: buildAnchorPayload(values.anchor) } : { ...values, anchor: undefined };
    setSaving(true);
    try {
      const res = await fetch(isNew ? '/api/properties' : `/api/properties/${(editing as PropertyGroupUnit).id}`, {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        message.error((await res.json()).error ?? '儲存失敗');
        return;
      }
      const json = (await res.json().catch(() => ({}))) as { data?: { id?: string; existing?: boolean; verification_status?: PropertyVerificationStatus } };
      onClose();
      if (isNew && json.data?.existing && json.data.id) {
        // 這個鍵已由自己的組織登錄（MIL-144）：沒有建新物件，帶使用者到既有的那筆
        message.info('這個物件你已經登錄過，已帶你到既有的物件');
        router.push(`/properties/${json.data.id}`);
        return;
      }
      // 鍵有沒有與別的組織重複，訊息都一樣（ADR-0028 決議 2）
      message.success(isNew ? registeredMessage(json.data?.verification_status ?? 'pending_verification') : '物件已更新');
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={editing === 'new' ? '新增物件' : '編輯物件'}
      open={editing !== null}
      onOk={() => void save()}
      confirmLoading={saving}
      onCancel={onClose}
      okText="儲存"
      cancelText="取消"
      width={720}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" initialValues={initialValues}>
        <Form.Item name="name" label="物件名稱" rules={[{ required: true, message: '請輸入名稱' }]}>
          <Input placeholder="例：大安區溫馨兩房" />
        </Form.Item>
        <Form.Item name="address" label="完整地址" rules={[{ required: true, message: '請輸入地址' }]}>
          <Input placeholder="例：台北市大安區和平東路二段 100 號 3 樓" />
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
  );
}
