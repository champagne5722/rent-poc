'use client';

// 物件詳情「建號與核對」分頁的建號區塊（MIL-143、MIL-177）。
// 顯示核對狀態與使用者填的建號。物件通過文件核對前，使用者能補建號與修正建號（ADR-0028 決議 9）。
// 核對狀態只來自 verification_status，不讀內部狀態。鍵有沒有與別的組織重複，畫面看不出來（ADR-0028 決議 1）。

import { useState } from 'react';
import { Alert, App as AntApp, Button, Descriptions, Flex, Form, Modal, Typography } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import { useRouter } from 'next/navigation';
import { AnchorKeyFields } from '@/components/AnchorFields';
import EmptyState from '@/components/page/EmptyState';
import StatusTag from '@/components/StatusTag';
import { REKEY_REVIEW_MESSAGE } from '@/lib/ownership/messages';
import { anchorKeyText, anchorLocationText, registeredMessage } from '@/lib/properties/anchor-display';
import { buildAnchorPayload } from '@/lib/properties/anchor-form';
import type { Property, PropertyVerificationStatus } from '@/lib/types';

interface AnchorPanelProps {
  property: Property;
  /** 補建號或修正建號後呼叫，父頁請 server component 重新載入。 */
  onChanged: () => void;
}

export default function AnchorPanel({ property, onChanged }: AnchorPanelProps) {
  const { message } = AntApp.useApp();
  const router = useRouter();
  const [form] = Form.useForm();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const anchor = property.anchor;

  if (!anchor) return <EmptyState description="讀不到這個物件的建號資料。請重新整理頁面，仍然失敗時請稍後再試。" />;

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
        onChanged();
        return;
      }
      message.success(registeredMessage((json.data?.verification_status ?? 'pending_verification') as PropertyVerificationStatus));
      onChanged();
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
          { key: 'status', label: '核對狀態', children: <StatusTag kind="propertyVerification" value={property.verification_status} /> },
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
          <Typography.Text type="secondary">建號填錯時可以修正。文件正在核對時不能修正，物件已核對後修正建號需要平台審核。</Typography.Text>
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
