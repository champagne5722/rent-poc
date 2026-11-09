'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, App as AntApp, Button, Card, Flex, Form, Input, Popconfirm, Select, Table, Tag, Typography, Upload, type UploadFile } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import { practitionerTitle, type CertificateKind } from '@/lib/labels';
import { practitionerPhaseView, type PractitionerPhase } from '@/lib/practice-entities/display';
import { EVIDENCE_MAX_BYTES, EVIDENCE_MAX_FILES } from '@/lib/practice-entities/rules';
import { CERTIFICATE_KINDS, certificateBadge, checkValidUntilConsistency, prefillValidUntil } from '@/lib/registry-rules';
import type { MyCertificate, MyEmployment } from '@/lib/practitioners/applicant';
import { taiwanDate } from '@/lib/practitioners/dates';
import { CERT_WORD_MAX, formatCertificateNumber } from '@/lib/practitioners/rules';

// 我的證書（MIL-111，ADR-0022 決議 9）：執業人員本人登錄證書、上傳影本、看任職與補件原因。
// 開啟後先顯示「證書資料個資告知」，同意才顯示登錄表單（P0-24 AC3）。告知文字取自程式內常數，標示待法務確認。
// 專任阻擋時，訊息固定為「此證號已有在職紀錄」，不顯示別的執業主體。
// 按鈕是否可用只是方便，權限在 /api/practitioner/* 的 route 判斷。

const KIND_OPTIONS = CERTIFICATE_KINDS.map((kind) => ({ value: kind, label: practitionerTitle(kind) }));
const ACCEPT = 'application/pdf,image/png,image/jpeg';
const STATE_TONE = { pending: undefined, verified: 'success', lapsed: 'error' } as const;
const STATE_LABEL = { pending: '待驗證', verified: '已驗證', lapsed: '已失效' } as const;

interface Payload {
  entityRegistered: boolean;
  certificates: MyCertificate[];
  myEmployments: MyEmployment[];
  consent: { decision: 'agree' | 'object'; isCurrentVersion: boolean } | null;
  notice: { version: number; title: string; text: string; legalReview: 'pending' | 'approved' };
  canWrite: boolean;
  today: string;
}

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

function PractitionerPanelInner() {
  const { message } = AntApp.useApp();
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form] = Form.useForm<FormValues>();
  const kind = Form.useWatch('certificateKind', form);
  const issuedOn = Form.useWatch('issuedOn', form);
  const validUntil = Form.useWatch('validUntil', form);

  const load = useCallback(async (): Promise<{ payload: Payload } | { error: string }> => {
    try {
      const response = await fetch('/api/practitioner/me');
      if (response.status === 403) return { error: '目前的身分不是執業主體組織。請從右上角切換身分。' };
      if (!response.ok) throw new Error(String(response.status));
      return { payload: ((await response.json()) as { data: Payload }).data };
    } catch {
      return { error: '證書資料載入失敗，請重新整理。' };
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

  async function send(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; body: Reply }> {
    const response = await fetch(url, init);
    return { ok: response.ok, status: response.status, body: ((await response.json().catch(() => ({}))) as Reply) ?? {} };
  }

  async function decide(decision: 'agree' | 'object') {
    setBusy(true);
    try {
      const result = await send('/api/practitioner/consent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }) });
      if (!result.ok) message.error(result.body.error ?? '送出失敗，請稍後再試');
      apply(await load());
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
        apply(await load());
      } else if (result.status === 409) {
        apply(await load());
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
        apply(await load());
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
      if (showResult(result, '同意書已送出，平台營運者核對後會更新狀態。')) apply(await load());
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
      if (showResult(result, '任職已結束。')) apply(await load());
      else if (result.status === 409) apply(await load());
    } catch {
      message.error('網路發生問題，請稍後再試');
    } finally {
      setBusy(false);
    }
  }

  if (error) return <Alert type="error" showIcon title={error} />;
  if (!data) return <Typography.Text type="secondary">載入中…</Typography.Text>;

  // 第一步：個資告知。目前版本沒有同意就只顯示告知
  const agreed = data.consent?.decision === 'agree' && data.consent.isCurrentVersion;
  if (!agreed) {
    return (
      <Flex vertical gap="middle" style={{ maxWidth: 720 }}>
        <Card title={data.notice.title} size="small">
          <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>{data.notice.text}</Typography.Paragraph>
        </Card>
        {data.consent?.decision === 'object' && data.consent.isCurrentVersion && (
          <Alert type="info" showIcon title="你選擇了不同意，所以不能登錄證書。如果改變心意，可以隨時同意。" />
        )}
        {data.canWrite ? (
          <Flex gap="small" wrap>
            <Button type="primary" loading={busy} onClick={() => void decide('agree')}>
              我已閱讀並同意
            </Button>
            {!(data.consent?.decision === 'object' && data.consent.isCurrentVersion) && (
              <Button loading={busy} onClick={() => void decide('object')}>
                不同意
              </Button>
            )}
          </Flex>
        ) : (
          <Typography.Text type="secondary">你的角色是唯讀，不能登錄證書。</Typography.Text>
        )}
      </Flex>
    );
  }

  const selectedCert = data.certificates.find((c) => c.kind === kind);
  const liveEmployment = (certificateId: string) => data.myEmployments.some((e) => e.practitionerId === certificateId && e.state !== 'lapsed');
  const canJustEmploy = selectedCert !== undefined && selectedCert.state === 'verified' && !liveEmployment(selectedCert.id);
  const consistency = issuedOn && validUntil && /^\d{4}-\d{2}-\d{2}$/.test(issuedOn) && /^\d{4}-\d{2}-\d{2}$/.test(validUntil) ? checkValidUntilConsistency(issuedOn, validUntil) : null;
  const needsAction = data.certificates.filter((c) => c.phase === 'needs_resubmission' || c.phase === 'lapsed');

  return (
    <Flex vertical gap="large" style={{ maxWidth: 960 }}>
      {needsAction.map((cert) => (
        <Alert
          key={cert.id}
          type={cert.phase === 'lapsed' ? 'error' : 'warning'}
          showIcon
          title={`${practitionerTitle(cert.kind)}：${cert.phase === 'lapsed' ? '已失效，請重新送件' : '需要補件'}`}
          description={cert.lastNote ?? undefined}
        />
      ))}
      {data.myEmployments
        .filter((e) => e.phase === 'needs_resubmission' || e.consentPhase === 'needs_resubmission')
        .map((e) => (
          <Alert
            key={e.id}
            type="warning"
            showIcon
            title={`${practitionerTitle(e.certificateKind)}的${e.consentPhase === 'needs_resubmission' ? '同意書' : '任職'}需要補件`}
            description={(e.consentPhase === 'needs_resubmission' ? e.consentNote : e.lastNote) ?? undefined}
          />
        ))}

      <Flex vertical gap="small">
        <Typography.Title level={5} style={{ margin: 0 }}>
          我的證書
        </Typography.Title>
        <Table<MyCertificate>
          size="middle"
          rowKey="id"
          pagination={false}
          dataSource={data.certificates}
          locale={{ emptyText: '還沒有登錄證書。' }}
          scroll={{ x: 'max-content' }}
          columns={[
            { title: '證書種類', dataIndex: 'kind', render: (k: CertificateKind) => practitionerTitle(k) },
            { title: '證號', key: 'number', render: (_v, cert) => formatCertificateNumber(cert.number) },
            { title: '發證日', dataIndex: 'issuedOn', width: 120 },
            { title: '效期', dataIndex: 'validUntil', width: 120 },
            { title: '驗證狀態', dataIndex: 'state', width: 100, render: (state: MyCertificate['state']) => <Tag color={STATE_TONE[state]}>{STATE_LABEL[state]}</Tag> },
            {
              title: '進度',
              key: 'phase',
              width: 200,
              render: (_v, cert) => {
                const view = practitionerPhaseView(cert.phase as PractitionerPhase);
                return (
                  <Flex vertical gap={4}>
                    <Tag color={view.tone === 'default' ? undefined : view.tone} style={{ marginInlineEnd: 0, width: 'fit-content' }}>
                      {view.label}
                    </Tag>
                    {cert.phase === 'verified' && cert.lastCheckedAt && (
                      <Typography.Text type="secondary">{certificateBadge(formatDate(cert.lastCheckedAt)).display}</Typography.Text>
                    )}
                  </Flex>
                );
              },
            },
          ]}
        />
      </Flex>

      <Flex vertical gap="small">
        <Typography.Title level={5} style={{ margin: 0 }}>
          在這個執業主體的任職
        </Typography.Title>
        <Table<MyEmployment>
          size="middle"
          rowKey="id"
          pagination={false}
          dataSource={data.myEmployments}
          locale={{ emptyText: '還沒有任職。' }}
          scroll={{ x: 'max-content' }}
          columns={[
            { title: '證書種類', dataIndex: 'certificateKind', render: (k: CertificateKind) => practitionerTitle(k) },
            { title: '到職日', dataIndex: 'startedOn', width: 120 },
            { title: '離職日', dataIndex: 'endedOn', width: 120, render: (v: string | null) => v ?? '—' },
            {
              title: '任職進度',
              key: 'phase',
              width: 140,
              render: (_v, e) => {
                const view = practitionerPhaseView(e.phase);
                return (
                  <Flex vertical gap={4}>
                    <Tag color={view.tone === 'default' ? undefined : view.tone} style={{ marginInlineEnd: 0, width: 'fit-content' }}>
                      {view.label}
                    </Tag>
                    {e.consentedByEntity && <Typography.Text type="secondary">經所屬業者同意</Typography.Text>}
                  </Flex>
                );
              },
            },
            {
              title: '所屬業者同意書',
              key: 'consent',
              render: (_v, e) => {
                if (!e.consentRequired) return '不需要';
                if (e.consentPhase === 'verified') return e.consentValidUntil ? `已核對，有效至 ${e.consentValidUntil}` : '已核對';
                if (e.consentPhase === 'awaiting_review') return '待核對';
                return (
                  <Flex vertical gap={4}>
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
              render: (_v, e) =>
                e.state === 'verified' && data.canWrite ? (
                  <Popconfirm title="結束這筆任職？" description="結束後才能在別的執業主體建立任職。" okText="結束任職" cancelText="取消" onConfirm={() => void endEmployment(e.id)}>
                    <Button size="small" danger>
                      結束任職
                    </Button>
                  </Popconfirm>
                ) : null,
            },
          ]}
        />
      </Flex>

      {notice && <Alert type="info" showIcon title={notice} />}

      {!data.canWrite ? (
        <Typography.Text type="secondary">你的角色是唯讀，不能登錄證書。</Typography.Text>
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
          <Typography.Title level={5} style={{ marginTop: 0 }}>
            登錄或補件證書
          </Typography.Title>
          {blocked && <Alert type="error" showIcon title={blocked} style={{ marginBottom: 16 }} />}

          <Form.Item label="證書種類" name="certificateKind" rules={[{ required: true, message: '請選擇證書種類' }]} style={{ maxWidth: 320 }}>
            <Select options={KIND_OPTIONS} onChange={() => setBlocked(null)} />
          </Form.Item>

          {canJustEmploy && selectedCert ? (
            <Flex vertical gap="small" align="flex-start" style={{ marginBottom: 16 }}>
              <Alert
                type="info"
                showIcon
                title="這張證書已驗證，換公司時不需要重新送件。建立任職後，平台營運者只需要核對任職。"
              />
              <Button type="primary" loading={busy} onClick={() => void createEmployment(selectedCert.id)}>
                在這個執業主體建立任職
              </Button>
            </Flex>
          ) : selectedCert?.state === 'verified' ? (
            <Alert type="success" showIcon title="這張證書已驗證，不需要再送件。" style={{ marginBottom: 16 }} />
          ) : (
            <>
              <Typography.Text type="secondary">證號（年、字、號）</Typography.Text>
              <Flex gap="small" wrap align="flex-start" style={{ marginTop: 4 }}>
                <Form.Item name="certYear" style={{ flex: '1 1 100px' }} rules={[{ required: true, pattern: /^[0-9]{2,4}$/, message: '年請填 2 到 4 位數字' }]}>
                  <Input suffix="年" inputMode="numeric" maxLength={4} autoComplete="off" />
                </Form.Item>
                <Form.Item name="certWord" style={{ flex: '2 1 160px' }} rules={[{ required: true, whitespace: true, max: CERT_WORD_MAX, message: '請填證號的字' }]}>
                  <Input suffix="字第" autoComplete="off" />
                </Form.Item>
                <Form.Item name="certSerial" style={{ flex: '2 1 160px' }} rules={[{ required: true, pattern: /^[0-9]{1,10}$/, message: '號請填 1 到 10 位數字' }]}>
                  <Input suffix="號" inputMode="numeric" maxLength={10} autoComplete="off" />
                </Form.Item>
              </Flex>

              <Flex gap="small" wrap align="flex-start">
                <Form.Item
                  label="發證日"
                  name="issuedOn"
                  style={{ flex: '1 1 200px' }}
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
                  style={{ flex: '1 1 200px' }}
                  rules={[{ required: true, message: '請填效期' }]}
                  help={consistency && !consistency.consistent ? consistency.message : undefined}
                  validateStatus={consistency && !consistency.consistent ? 'warning' : undefined}
                >
                  <Input type="date" />
                </Form.Item>
                <Form.Item label="到職日" name="startedOn" style={{ flex: '1 1 200px' }} extra="沒填就是今天。">
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
    </Flex>
  );
}

// 沿用成員管理頁的做法：頁面自己包 AntApp，message 才吃得到主題
export default function PractitionerPanel() {
  return (
    <AntApp>
      <PractitionerPanelInner />
    </AntApp>
  );
}
