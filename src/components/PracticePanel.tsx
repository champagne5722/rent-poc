'use client';

import { useState, useTransition } from 'react';
import { Alert, App as AntApp, Button, Descriptions, Flex, Form, Input, Select, Upload, type UploadFile } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import { useRouter } from 'next/navigation';
import EmptyState from '@/components/page/EmptyState';
import ListTable from '@/components/page/ListTable';
import SettingsPage from '@/components/page/SettingsPage';
import SettingsSection from '@/components/page/SettingsSection';
import StatusTag from '@/components/StatusTag';
import { statutoryTitle, type LicenseKind } from '@/lib/labels';
import { EVIDENCE_MAX_BYTES, EVIDENCE_MAX_FILES, PERMIT_NO_MAX } from '@/lib/practice-entities/rules';
import type { MyLicense, MyRegistration } from '@/lib/practice-entities/applicant';
import type { OrgEmployment } from '@/lib/practitioners/applicant';
import EmploymentList from './EmploymentList';
import styles from './PracticePanel.module.css';

// 執業主體的登錄進度與送件（MIL-109、MIL-181，ADR-0017）。每個業別一列：驗證狀態、進度、營運者的補件原因。
// 送件寫成待驗證，平台營運者在審核台核對。相符後業別轉已驗證，證明文件刪除。
// 按鈕是否可用只是方便，權限在 /api/practice/* 的 route 判斷。登錄者與認領同一統編的組織看到的畫面相同。
// 資料由 server component 載入後傳進來，送件成功後呼叫 router.refresh()。

const KIND_OPTIONS: Array<{ value: LicenseKind; label: string }> = (['management', 'master_lease', 'brokerage'] as const).map((kind) => ({
  value: kind,
  label: statutoryTitle(kind),
}));
const ENTITY_TYPE_LABEL = { company: '公司', firm: '商號' } as const;
const ACCEPT = 'application/pdf,image/png,image/jpeg';

// 固定用台灣時間，讓 server 與瀏覽器渲染的文字一致
const dateTimeFormat = new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short', hour12: false, timeZone: 'Asia/Taipei' });
const formatDate = (iso: string | null) => (iso ? dateTimeFormat.format(new Date(iso)) : '—');

interface FormValues {
  kind: LicenseKind;
  permitNo: string;
  files: UploadFile[];
}

export interface PracticePanelProps {
  registration: MyRegistration | null;
  canSubmit: boolean;
  orgEmployments: OrgEmployment[];
  isAdmin: boolean;
}

function PracticePanelInner({ registration, canSubmit, orgEmployments, isAdmin }: PracticePanelProps) {
  const { message } = AntApp.useApp();
  const router = useRouter();
  const [, startRefresh] = useTransition();
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm<FormValues>();

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
        startRefresh(() => router.refresh());
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

  if (!registration) {
    return (
      <SettingsPage header={{ title: '執業主體登錄' }}>
        <EmptyState description="這個組織沒有執業主體登錄。請向平台營運者確認組織的類型。" />
      </SettingsPage>
    );
  }

  const needsAction = registration.licenses.filter((l) => l.phase === 'needs_resubmission' || l.phase === 'lapsed');

  return (
    <SettingsPage
      header={{ title: '執業主體登錄' }}
      notices={
        needsAction.length > 0 && (
          <Flex vertical gap="small">
            {needsAction.map((license) => (
              <Alert
                key={license.kind}
                type={license.phase === 'lapsed' ? 'error' : 'warning'}
                showIcon
                title={`${statutoryTitle(license.kind)}：${license.phase === 'lapsed' ? '已失效，請重新送件' : '需要補件'}`}
                description={license.lastNote ?? undefined}
              />
            ))}
          </Flex>
        )
      }
    >
      <SettingsSection title="基本資料">
        <Descriptions
          size="small"
          column={{ xs: 1, sm: 3 }}
          items={[
            { key: 'name', label: '名稱', children: registration.name },
            { key: 'taxId', label: '統一編號', children: registration.taxId },
            { key: 'type', label: '組織型態', children: ENTITY_TYPE_LABEL[registration.entityType] },
          ]}
        />
      </SettingsSection>

      <SettingsSection title="業別">
        <ListTable<MyLicense>
          emptyNode={<EmptyState description="還沒有業別。送件後，這裡會顯示驗證進度。" />}
          table={{
            rowKey: 'kind',
            dataSource: registration.licenses,
            scroll: { x: 'max-content' },
            columns: [
              { title: '業別', dataIndex: 'kind', render: (kind: LicenseKind) => statutoryTitle(kind) },
              { title: '許可或登記證字號', dataIndex: 'permitNo', render: (value: string | null) => value ?? '—' },
              { title: '驗證狀態', dataIndex: 'state', width: 110, render: (_state, license) => <StatusTag kind="credentialState" value={license.state} /> },
              { title: '進度', dataIndex: 'phase', width: 110, render: (_phase, license) => <StatusTag kind="licensePhase" value={license.phase} /> },
              { title: '送件時間', dataIndex: 'submittedAt', width: 180, render: formatDate },
            ],
          }}
        />
      </SettingsSection>

      <EmploymentList orgEmployments={orgEmployments} isAdmin={isAdmin} />

      <SettingsSection title="送件或補件">
        {canSubmit ? (
          <Form<FormValues>
            form={form}
            layout="vertical"
            requiredMark={false}
            initialValues={{ kind: needsAction[0]?.kind ?? registration.licenses.find((l) => l.phase === 'not_submitted')?.kind ?? registration.licenses[0]?.kind }}
            onFinish={(values) => void submit(values)}
          >
            <Flex gap="small" wrap align="flex-start">
              <Form.Item label="業別" name="kind" className={styles.kindField} rules={[{ required: true, message: '請選擇業別' }]}>
                <Select options={KIND_OPTIONS} />
              </Form.Item>
              <Form.Item
                label="許可或登記證字號"
                name="permitNo"
                className={styles.permitField}
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
          <Alert type="info" showIcon title="你的角色是唯讀，不能送件。請通知組織管理員或業務人員送件。" />
        )}
      </SettingsSection>
    </SettingsPage>
  );
}

// 頁面自己包 AntApp，message 才吃得到主題
export default function PracticePanel(props: PracticePanelProps) {
  return (
    <AntApp>
      <PracticePanelInner {...props} />
    </AntApp>
  );
}
