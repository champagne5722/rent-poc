'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, App as AntApp, Button, Descriptions, Empty, Flex, Form, Input, Select, Table, Tag, Typography, Upload, type UploadFile } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import { statutoryTitle, type LicenseKind } from '@/lib/labels';
import { phaseView, stateLabel } from '@/lib/practice-entities/display';
import { EVIDENCE_MAX_BYTES, EVIDENCE_MAX_FILES, PERMIT_NO_MAX } from '@/lib/practice-entities/rules';
import type { MyLicense, MyRegistration } from '@/lib/practice-entities/applicant';
import EmploymentList from './EmploymentList';

// 執業主體的登錄進度與送件（MIL-109，ADR-0017）。每個業別一列：驗證狀態、進度、營運者的補件原因。
// 送件寫成待驗證，平台營運者在審核台核對。相符後業別轉已驗證，證明文件刪除。
// 按鈕是否可用只是方便，權限在 /api/practice/* 的 route 判斷。登錄者與認領同一統編的組織看到的畫面相同。

const KIND_OPTIONS: Array<{ value: LicenseKind; label: string }> = (['management', 'master_lease', 'brokerage'] as const).map((kind) => ({
  value: kind,
  label: statutoryTitle(kind),
}));
const ENTITY_TYPE_LABEL = { company: '公司', firm: '商號' } as const;
const ACCEPT = 'application/pdf,image/png,image/jpeg';

interface Payload {
  registration: MyRegistration | null;
  canSubmit: boolean;
}

interface FormValues {
  kind: LicenseKind;
  permitNo: string;
  files: UploadFile[];
}

const formatDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-TW', { hour12: false }) : '—');

function PracticePanelInner() {
  const { message } = AntApp.useApp();
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm<FormValues>();

  const load = useCallback(async (): Promise<{ payload: Payload } | { error: string }> => {
    try {
      const response = await fetch('/api/practice/registration');
      if (response.status === 403) return { error: '目前的身分不是執業主體組織。請從右上角切換身分。' };
      if (!response.ok) throw new Error(String(response.status));
      return { payload: ((await response.json()) as { data: Payload }).data };
    } catch {
      return { error: '登錄進度載入失敗，請重新整理。' };
    }
  }, []);

  const apply = useCallback((result: { payload: Payload } | { error: string }) => {
    if ('payload' in result) {
      setData(result.payload);
      setError(null);
    } else {
      setError(result.error);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void load().then((result) => {
      if (!cancelled) apply(result);
    });
    return () => {
      cancelled = true;
    };
  }, [apply, load]);

  async function submit(values: FormValues) {
    setBusy(true);
    try {
      const body = new FormData();
      body.set('kind', values.kind);
      body.set('permitNo', values.permitNo);
      for (const file of values.files ?? []) if (file.originFileObj) body.append('files', file.originFileObj);
      const response = await fetch('/api/practice/licenses', { method: 'POST', body });
      if (response.ok) {
        message.success('已送出，平台營運者核對後會更新狀態。');
        form.resetFields(['permitNo', 'files']);
        apply(await load());
      } else {
        const payload = (await response.json().catch(() => ({}))) as { error?: string; field?: string };
        if (payload.field === 'permitNo' || payload.field === 'files' || payload.field === 'kind') {
          form.setFields([{ name: payload.field, errors: [payload.error ?? '欄位有誤'] }]);
        } else {
          message.error(payload.error ?? '送出失敗，請稍後再試');
        }
      }
    } catch {
      message.error('網路發生問題，請稍後再試');
    } finally {
      setBusy(false);
    }
  }

  if (error) return <Alert type="error" showIcon title={error} />;
  if (!data) return <Typography.Text type="secondary">載入中…</Typography.Text>;
  if (!data.registration) return <Empty description="這個組織沒有執業主體登錄。" />;

  const { registration } = data;
  const needsAction = registration.licenses.filter((l) => l.phase === 'needs_resubmission' || l.phase === 'lapsed');

  return (
    <Flex vertical gap="large" style={{ maxWidth: 960 }}>
      <Descriptions
        size="small"
        column={{ xs: 1, sm: 3 }}
        items={[
          { key: 'name', label: '名稱', children: registration.name },
          { key: 'taxId', label: '統一編號', children: registration.taxId },
          { key: 'type', label: '組織型態', children: ENTITY_TYPE_LABEL[registration.entityType] },
        ]}
      />

      {needsAction.map((license) => (
        <Alert
          key={license.kind}
          type={license.phase === 'lapsed' ? 'error' : 'warning'}
          showIcon
          title={`${statutoryTitle(license.kind)}：${license.phase === 'lapsed' ? '已失效，請重新送件' : '需要補件'}`}
          description={license.lastNote ?? undefined}
        />
      ))}

      <Flex vertical gap="small">
        <Typography.Title level={5} style={{ margin: 0 }}>
          業別
        </Typography.Title>
        <Table<MyLicense>
          size="middle"
          rowKey="kind"
          pagination={false}
          dataSource={registration.licenses}
          scroll={{ x: 'max-content' }}
          columns={[
            { title: '業別', dataIndex: 'kind', render: (kind: LicenseKind) => statutoryTitle(kind) },
            { title: '許可或登記證字號', dataIndex: 'permitNo', render: (value: string | null) => value ?? '—' },
            { title: '驗證狀態', dataIndex: 'state', width: 110, render: (_state, license) => <Tag>{stateLabel(license.state)}</Tag> },
            {
              title: '進度',
              dataIndex: 'phase',
              width: 110,
              render: (_phase, license) => {
                const view = phaseView(license.phase);
                return <Tag color={view.tone === 'default' ? undefined : view.tone}>{view.label}</Tag>;
              },
            },
            { title: '送件時間', dataIndex: 'submittedAt', width: 180, render: formatDate },
          ]}
        />
      </Flex>

      <EmploymentList />

      {data.canSubmit ? (
        <Form<FormValues>
          form={form}
          layout="vertical"
          requiredMark={false}
          initialValues={{ kind: needsAction[0]?.kind ?? registration.licenses.find((l) => l.phase === 'not_submitted')?.kind ?? registration.licenses[0]?.kind }}
          onFinish={(values) => void submit(values)}
        >
          <Typography.Title level={5} style={{ marginTop: 0 }}>
            送件或補件
          </Typography.Title>
          <Flex gap="small" wrap align="flex-start">
            <Form.Item label="業別" name="kind" style={{ flex: '1 1 240px' }} rules={[{ required: true, message: '請選擇業別' }]}>
              <Select options={KIND_OPTIONS} />
            </Form.Item>
            <Form.Item
              label="許可或登記證字號"
              name="permitNo"
              style={{ flex: '2 1 320px' }}
              rules={[
                { required: true, whitespace: true, message: '請輸入許可或登記證字號' },
                { max: PERMIT_NO_MAX, message: `字號不得超過 ${PERMIT_NO_MAX} 字` },
              ]}
            >
              <Input autoComplete="off" />
            </Form.Item>
          </Flex>
          <Form.Item
            label="證明文件"
            name="files"
            valuePropName="fileList"
            getValueFromEvent={(event: { fileList: UploadFile[] }) => event.fileList}
            extra={`PDF、PNG 或 JPEG，最多 ${EVIDENCE_MAX_FILES} 個，每個不超過 ${EVIDENCE_MAX_BYTES / 1024 / 1024} MB。平台營運者核對相符後會刪除這些檔案。`}
            rules={[{ required: true, type: 'array', min: 1, message: '請上傳至少一個證明文件' }]}
          >
            <Upload accept={ACCEPT} multiple maxCount={EVIDENCE_MAX_FILES} beforeUpload={() => false}>
              <Button icon={<UploadOutlined />}>選擇檔案</Button>
            </Upload>
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={busy}>
            送出
          </Button>
        </Form>
      ) : (
        <Typography.Text type="secondary">你的角色是唯讀，不能送件。</Typography.Text>
      )}
    </Flex>
  );
}

// 沿用成員管理頁的做法：頁面自己包 AntApp，message 才吃得到主題
export default function PracticePanel() {
  return (
    <AntApp>
      <PracticePanelInner />
    </AntApp>
  );
}
