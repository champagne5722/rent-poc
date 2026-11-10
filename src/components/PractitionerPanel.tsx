'use client';

import { useState, useTransition } from 'react';
import { Alert, App as AntApp, Button, Flex, Form, Input, Popconfirm, Select, Typography, Upload, type UploadFile } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import { useRouter } from 'next/navigation';
import EmptyState from '@/components/page/EmptyState';
import ListTable from '@/components/page/ListTable';
import SettingsPage from '@/components/page/SettingsPage';
import SettingsSection from '@/components/page/SettingsSection';
import StatusTag from '@/components/StatusTag';
import { practitionerTitle, type CertificateKind } from '@/lib/labels';
import type { PractitionerPhase } from '@/lib/practice-entities/display';
import { EVIDENCE_MAX_BYTES, EVIDENCE_MAX_FILES } from '@/lib/practice-entities/rules';
import { CERTIFICATE_KINDS, certificateBadge, checkValidUntilConsistency, prefillValidUntil } from '@/lib/registry-rules';
import type { MyCertificate, MyEmployment } from '@/lib/practitioners/applicant';
import { taiwanDate } from '@/lib/practitioners/dates';
import type { PractitionerMe } from '@/lib/practitioners/me';
import { CERT_WORD_MAX, formatCertificateNumber } from '@/lib/practitioners/rules';
import styles from './PractitionerPanel.module.css';

// 我的證書（MIL-111、MIL-181，ADR-0022 決議 9）：執業人員本人登錄證書、上傳影本、看任職與補件原因。
// 開啟後先顯示「證書資料個資告知」，同意才顯示登錄表單（P0-24 AC3）。告知文字取自程式內常數，標示待法務確認。
// 專任阻擋時，訊息固定為「此證號已有在職紀錄」，不顯示別的執業主體。
// 按鈕是否可用只是方便，權限在 /api/practitioner/* 的 route 判斷。
// 資料由 server component 載入後傳進來，每個操作成功後呼叫 router.refresh() 重新載入。

const KIND_OPTIONS = CERTIFICATE_KINDS.map((kind) => ({ value: kind, label: practitionerTitle(kind) }));
const ACCEPT = 'application/pdf,image/png,image/jpeg';

interface FormValues {
  certificateKind: CertificateKind;
  certYear: string;
  certWord: string;
  certSerial: string;
  issuedOn: string;
  validUntil: string;
  startedOn?: string;
  files: UploadFile[];
}

interface Reply {
  error?: string;
  field?: string;
  code?: string;
  data?: { employment?: { consentRequired: boolean; notice: string | null } | null; consentRequired?: boolean; notice?: string | null; validUntilHint?: string | null };
}

const formatDate = (iso: string | null) => (iso ? taiwanDate(new Date(iso)) : '—');
const FIELD_NAMES = ['certificateKind', 'certYear', 'certWord', 'certSerial', 'issuedOn', 'validUntil', 'startedOn', 'files'] as const;

async function send(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; body: Reply }> {
  const response = await fetch(url, init);
  return { ok: response.ok, status: response.status, body: ((await response.json().catch(() => ({}))) as Reply) ?? {} };
}

export interface PractitionerPanelProps {
  data: PractitionerMe;
}

function PractitionerPanelInner({ data }: PractitionerPanelProps) {
  const { message } = AntApp.useApp();
  const router = useRouter();
  const [, startRefresh] = useTransition();
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form] = Form.useForm<FormValues>();
  const kind = Form.useWatch('certificateKind', form);
  const issuedOn = Form.useWatch('issuedOn', form);
  const validUntil = Form.useWatch('validUntil', form);
  const refresh = () => startRefresh(() => router.refresh());

  async function decide(decision: 'agree' | 'object') {
    setBusy(true);
    try {
      const result = await send('/api/practitioner/consent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }) });
      if (!result.ok) message.error(result.body.error ?? '送出失敗，請稍後再試');
      refresh();
    } catch {
      message.error('網路發生問題，請稍後再試');
    } finally {
      setBusy(false);
    }
  }

  function showResult(result: { ok: boolean; status: number; body: Reply }, success: string): boolean {
    if (result.ok) {
      message.success(success);
      return true;
    }
    if (result.body.code === 'employment_blocked') {
      setBlocked(result.body.error ?? null);
    } else if (result.body.field && (FIELD_NAMES as readonly string[]).includes(result.body.field)) {
      form.setFields([{ name: result.body.field as keyof FormValues, errors: [result.body.error ?? '欄位有誤'] }]);
    } else {
      message.error(result.body.error ?? '送出失敗，請稍後再試');
    }
    return false;
  }

  async function submit(values: FormValues) {
    setBusy(true);
    setBlocked(null);
    setNotice(null);
    try {
      const body = new FormData();
      for (const name of ['certificateKind', 'certYear', 'certWord', 'certSerial', 'issuedOn', 'validUntil', 'startedOn'] as const) {
        const value = values[name];
        if (typeof value === 'string' && value !== '') body.set(name, value);
      }
      for (const file of values.files ?? []) if (file.originFileObj) body.append('files', file.originFileObj);
      const result = await send('/api/practitioner/certificates', { method: 'POST', body });
      if (showResult(result, '已送出，平台營運者核對後會更新狀態。')) {
        setNotice(result.body.data?.employment?.notice ?? null);
        form.resetFields(['certYear', 'certWord', 'certSerial', 'issuedOn', 'validUntil', 'startedOn', 'files']);
        refresh();
      } else if (result.status === 409) {
        refresh();
      }
    } catch {
      message.error('網路發生問題，請稍後再試');
    } finally {
      setBusy(false);
    }
  }

  async function createEmployment(certificateId: string) {
    setBusy(true);
    setBlocked(null);
    setNotice(null);
    try {
      const result = await send('/api/practitioner/employments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ certificateId }),
      });
      if (showResult(result, '已建立任職，平台營運者核對後會更新狀態。')) {
        setNotice(result.body.data && 'notice' in result.body.data ? (result.body.data.notice ?? null) : null);
        refresh();
      }
    } catch {
      message.error('網路發生問題，請稍後再試');
    } finally {
      setBusy(false);
    }
  }

  async function uploadConsent(employmentId: string, file: File) {
    setBusy(true);
    try {
      const body = new FormData();
      body.append('files', file);
      const result = await send(`/api/practitioner/employments/${employmentId}/consent-letter`, { method: 'POST', body });
      if (showResult(result, '同意書已送出，平台營運者核對後會更新狀態。')) refresh();
    } catch {
      message.error('網路發生問題，請稍後再試');
    } finally {
      setBusy(false);
    }
  }

  async function endEmployment(employmentId: string) {
    setBusy(true);
    try {
      const result = await send(`/api/practitioner/employments/${employmentId}/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (showResult(result, '任職已結束。')) refresh();
      else if (result.status === 409) refresh();
    } catch {
      message.error('網路發生問題，請稍後再試');
    } finally {
      setBusy(false);
    }
  }

  const header = { title: '證書與任職' };

  // 第一步：個資告知。目前版本沒有同意就只顯示告知
  const agreed = data.consent?.decision === 'agree' && data.consent.isCurrentVersion;
  if (!agreed) {
    const objected = data.consent?.decision === 'object' && data.consent.isCurrentVersion;
    return (
      <SettingsPage header={header}>
        <SettingsSection title={data.notice.title}>
          <Typography.Paragraph className={styles.noticeText}>{data.notice.text}</Typography.Paragraph>
          {objected && <Alert type="info" showIcon title="你選擇了不同意，所以不能登錄證書。如果改變心意，可以隨時同意。" />}
          {data.canWrite ? (
            <Flex gap="small" wrap>
              <Button type="primary" loading={busy} onClick={() => void decide('agree')}>
                我已閱讀並同意
              </Button>
              {!objected && (
                <Button loading={busy} onClick={() => void decide('object')}>
                  不同意
                </Button>
              )}
            </Flex>
          ) : (
            <Alert type="info" showIcon title="你的角色是唯讀，不能登錄證書。" />
          )}
        </SettingsSection>
      </SettingsPage>
    );
  }

  const selectedCert = data.certificates.find((c) => c.kind === kind);
  const liveEmployment = (certificateId: string) => data.myEmployments.some((e) => e.practitionerId === certificateId && e.state !== 'lapsed');
  const canJustEmploy = selectedCert !== undefined && selectedCert.state === 'verified' && !liveEmployment(selectedCert.id);
  const consistency = issuedOn && validUntil && /^\d{4}-\d{2}-\d{2}$/.test(issuedOn) && /^\d{4}-\d{2}-\d{2}$/.test(validUntil) ? checkValidUntilConsistency(issuedOn, validUntil) : null;
  const needsAction = data.certificates.filter((c) => c.phase === 'needs_resubmission' || c.phase === 'lapsed');
  const employmentsNeedingAction = data.myEmployments.filter((e) => e.phase === 'needs_resubmission' || e.consentPhase === 'needs_resubmission');

  return (
    <SettingsPage
      header={header}
      notices={
        needsAction.length + employmentsNeedingAction.length > 0 && (
          <Flex vertical gap="small">
            {needsAction.map((cert) => (
              <Alert
                key={cert.id}
                type={cert.phase === 'lapsed' ? 'error' : 'warning'}
                showIcon
                title={`${practitionerTitle(cert.kind)}：${cert.phase === 'lapsed' ? '已失效，請重新送件' : '需要補件'}`}
                description={cert.lastNote ?? undefined}
              />
            ))}
            {employmentsNeedingAction.map((e) => (
              <Alert
                key={e.id}
                type="warning"
                showIcon
                title={`${practitionerTitle(e.certificateKind)}的${e.consentPhase === 'needs_resubmission' ? '同意書' : '任職'}需要補件`}
                description={(e.consentPhase === 'needs_resubmission' ? e.consentNote : e.lastNote) ?? undefined}
              />
            ))}
          </Flex>
        )
      }
    >
      <SettingsSection title="我的證書">
        <ListTable<MyCertificate>
          emptyNode={<EmptyState description="還沒有登錄證書。用下方的「登錄或補件證書」送出第一張證書。" />}
          table={{
            rowKey: 'id',
            dataSource: data.certificates,
            scroll: { x: 'max-content' },
            columns: [
              { title: '證書種類', dataIndex: 'kind', render: (k: CertificateKind) => practitionerTitle(k) },
              { title: '證號', key: 'number', render: (_v, cert) => formatCertificateNumber(cert.number) },
              { title: '發證日', dataIndex: 'issuedOn', width: 120 },
              { title: '效期', dataIndex: 'validUntil', width: 120 },
              { title: '驗證狀態', dataIndex: 'state', width: 100, render: (state: MyCertificate['state']) => <StatusTag kind="credentialState" value={state} /> },
              {
                title: '進度',
                key: 'phase',
                width: 200,
                render: (_v, cert) => (
                  <Flex vertical gap={4} align="flex-start">
                    <StatusTag kind="practitionerPhase" value={cert.phase as PractitionerPhase} />
                    {cert.phase === 'verified' && cert.lastCheckedAt && (
                      <Typography.Text type="secondary">{certificateBadge(formatDate(cert.lastCheckedAt)).display}</Typography.Text>
                    )}
                  </Flex>
                ),
              },
            ],
          }}
        />
      </SettingsSection>

      <SettingsSection title="在這個執業主體的任職">
        <ListTable<MyEmployment>
          emptyNode={<EmptyState description="還沒有任職。證書驗證後，用下方的「登錄或補件證書」建立任職。" />}
          table={{
            rowKey: 'id',
            dataSource: data.myEmployments,
            scroll: { x: 'max-content' },
            columns: [
              { title: '證書種類', dataIndex: 'certificateKind', render: (k: CertificateKind) => practitionerTitle(k) },
              { title: '到職日', dataIndex: 'startedOn', width: 120 },
              { title: '離職日', dataIndex: 'endedOn', width: 120, render: (v: string | null) => v ?? '—' },
              {
                title: '任職進度',
                key: 'phase',
                width: 140,
                render: (_v, e) => (
                  <Flex vertical gap={4} align="flex-start">
                    <StatusTag kind="practitionerPhase" value={e.phase} />
                    {e.consentedByEntity && <Typography.Text type="secondary">經所屬業者同意</Typography.Text>}
                  </Flex>
                ),
              },
              {
                title: '所屬業者同意書',
                key: 'consent',
                render: (_v, e) => {
                  if (!e.consentRequired) return '不需要';
                  if (e.consentPhase === 'verified') return e.consentValidUntil ? `已核對，有效至 ${e.consentValidUntil}` : '已核對';
                  if (e.consentPhase === 'awaiting_review') return '待核對';
                  return (
                    <Flex vertical gap={4} align="flex-start">
                      <Typography.Text>{e.consentPhase === 'needs_resubmission' ? '待補件' : e.consentPhase === 'ended' ? '已失效' : '尚未上傳'}</Typography.Text>
                      {data.canWrite && e.state !== 'lapsed' && (
                        <Upload
                          accept={ACCEPT}
                          showUploadList={false}
                          beforeUpload={(file) => {
                            void uploadConsent(e.id, file);
                            return false;
                          }}
                        >
                          <Button size="small" icon={<UploadOutlined />} loading={busy}>
                            上傳同意書
                          </Button>
                        </Upload>
                      )}
                    </Flex>
                  );
                },
              },
              {
                title: '操作',
                key: 'action',
                width: 110,
                fixed: 'right',
                render: (_v, e) =>
                  e.state === 'verified' && data.canWrite ? (
                    <Popconfirm title="結束這筆任職？" description="結束後才能在別的執業主體建立任職。" okText="結束任職" cancelText="取消" onConfirm={() => void endEmployment(e.id)}>
                      <Button type="link" size="small" danger>
                        結束任職
                      </Button>
                    </Popconfirm>
                  ) : null,
              },
            ],
          }}
        />
      </SettingsSection>

      {notice && <Alert type="info" showIcon title={notice} />}

      <SettingsSection title="登錄或補件證書">
        {!data.canWrite ? (
          <Alert type="info" showIcon title="你的角色是唯讀，不能登錄證書。" />
        ) : !data.entityRegistered ? (
          <Alert type="info" showIcon title="這個組織的執業主體還在審核中，審核完成後才能登錄任職。" />
        ) : (
          <Form<FormValues>
            form={form}
            layout="vertical"
            requiredMark={false}
            initialValues={{ certificateKind: data.certificates[0]?.kind ?? 'rental_housing_manager' }}
            onFinish={(values) => void submit(values)}
          >
            {blocked && <Alert type="error" showIcon title={blocked} className={styles.alertGap} />}

            <Form.Item label="證書種類" name="certificateKind" rules={[{ required: true, message: '請選擇證書種類' }]} className={styles.kindField}>
              <Select options={KIND_OPTIONS} onChange={() => setBlocked(null)} />
            </Form.Item>

            {canJustEmploy && selectedCert ? (
              <Flex vertical gap="small" align="flex-start">
                <Alert type="info" showIcon title="這張證書已驗證，換公司時不需要重新送件。建立任職後，平台營運者只需要核對任職。" />
                <Button type="primary" loading={busy} onClick={() => void createEmployment(selectedCert.id)}>
                  在這個執業主體建立任職
                </Button>
              </Flex>
            ) : selectedCert?.state === 'verified' ? (
              <Alert type="success" showIcon title="這張證書已驗證，不需要再送件。" />
            ) : (
              <>
                <Typography.Text type="secondary">證號（年、字、號）</Typography.Text>
                <Flex gap="small" wrap align="flex-start">
                  <Form.Item name="certYear" className={styles.yearField} rules={[{ required: true, pattern: /^[0-9]{2,4}$/, message: '年請填 2 到 4 位數字' }]}>
                    <Input suffix="年" inputMode="numeric" maxLength={4} autoComplete="off" />
                  </Form.Item>
                  <Form.Item name="certWord" className={styles.wordField} rules={[{ required: true, whitespace: true, max: CERT_WORD_MAX, message: '請填證號的字' }]}>
                    <Input suffix="字第" autoComplete="off" />
                  </Form.Item>
                  <Form.Item name="certSerial" className={styles.serialField} rules={[{ required: true, pattern: /^[0-9]{1,10}$/, message: '號請填 1 到 10 位數字' }]}>
                    <Input suffix="號" inputMode="numeric" maxLength={10} autoComplete="off" />
                  </Form.Item>
                </Flex>

                <Flex gap="small" wrap align="flex-start">
                  <Form.Item
                    label="發證日"
                    name="issuedOn"
                    className={styles.dateField}
                    rules={[{ required: true, message: '請填發證日' }]}
                    getValueFromEvent={(event: React.ChangeEvent<HTMLInputElement>) => {
                      const next = event.target.value;
                      // 效期預填發證日加 4 年，使用者可以改（以 resim 登錄的為準）
                      if (/^\d{4}-\d{2}-\d{2}$/.test(next) && !form.isFieldTouched('validUntil')) {
                        try {
                          form.setFieldValue('validUntil', prefillValidUntil(next));
                        } catch {
                          // 日期無效時不預填
                        }
                      }
                      return next;
                    }}
                  >
                    <Input type="date" max={data.today} />
                  </Form.Item>
                  <Form.Item
                    label="效期"
                    name="validUntil"
                    className={styles.dateField}
                    rules={[{ required: true, message: '請填效期' }]}
                    help={consistency && !consistency.consistent ? consistency.message : undefined}
                    validateStatus={consistency && !consistency.consistent ? 'warning' : undefined}
                  >
                    <Input type="date" />
                  </Form.Item>
                  <Form.Item label="到職日" name="startedOn" className={styles.dateField} extra="沒填就是今天。">
                    <Input type="date" />
                  </Form.Item>
                </Flex>

                <Form.Item
                  label="證書影本"
                  name="files"
                  valuePropName="fileList"
                  getValueFromEvent={(event: { fileList: UploadFile[] }) => event.fileList}
                  extra={`PDF、PNG 或 JPEG，最多 ${EVIDENCE_MAX_FILES} 個，每個不超過 ${EVIDENCE_MAX_BYTES / 1024 / 1024} MB。平台營運者核對相符後會刪除這些檔案。`}
                  rules={[{ required: true, type: 'array', min: 1, message: '請上傳至少一個證書影本' }]}
                >
                  <Upload accept={ACCEPT} multiple maxCount={EVIDENCE_MAX_FILES} beforeUpload={() => false}>
                    <Button icon={<UploadOutlined />}>選擇檔案</Button>
                  </Upload>
                </Form.Item>
                <Button type="primary" htmlType="submit" loading={busy}>
                  送出
                </Button>
              </>
            )}
          </Form>
        )}
      </SettingsSection>
    </SettingsPage>
  );
}

// 頁面自己包 AntApp，message 才吃得到主題
export default function PractitionerPanel(props: PractitionerPanelProps) {
  return (
    <AntApp>
      <PractitionerPanelInner {...props} />
    </AntApp>
  );
}
