'use client';

// 建約 wizard（規格 §7）：四步分頁流程，草稿的編輯體驗一律在這裡。
// 檢核與步驟推導的純邏輯在 src/lib/contract-wizard.ts，本檔只負責蒐集輸入、呼叫 API 與畫畫面。

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Row,
  Space,
  Spin,
  Steps,
  Tag,
  Typography,
} from 'antd';
import {
  CheckCircleTwoTone,
  CloseCircleTwoTone,
  LeftOutlined,
  RightOutlined,
  SendOutlined,
} from '@ant-design/icons';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import dayjs from 'dayjs';
import type { Contract, ContractFields, SignatureField } from '@/lib/types';
import SignatureFieldEditor from '@/components/SignatureFieldEditor';
import {
  DEFAULT_TEMPLATE,
  STEP_CONFIRM,
  STEP_FIELDS,
  STEP_PROPERTY,
  STEP_SIGNATURE,
  TENANT_FIRST_NOTICE,
  WIZARD_STEPS,
  checkSignatureFields,
  nextStepBlockReason,
  resumeStepIndex,
  sendBlockReason,
  stepStatuses,
} from '@/lib/contract-wizard';

/** 四步進度條；`/contracts/new` 的第①步也共用這一條。 */
export function WizardStepsBar({
  current,
  statuses,
}: {
  current: number;
  statuses?: ReturnType<typeof stepStatuses>;
}) {
  return (
    <Steps
      size="small"
      current={current}
      style={{ marginBottom: 16, maxWidth: 860 }}
      items={WIZARD_STEPS.map((step, index) => ({
        key: step.key,
        title: step.title,
        status: statuses?.[index],
      }))}
    />
  );
}

/** 範本區：單範本時顯示為說明，不做選擇（ADR-0005；選用條款另票）。 */
export function TemplateNotice() {
  return (
    <Alert
      type="info"
      showIcon
      message={`範本：${DEFAULT_TEMPLATE.name}，${DEFAULT_TEMPLATE.provider}`}
      description={`${DEFAULT_TEMPLATE.note}目前平台僅一份範本，系統自動選用。`}
    />
  );
}

function CheckLine({ ok, text }: { ok: boolean; text: string }) {
  return (
    <Space size={6}>
      {ok ? <CheckCircleTwoTone twoToneColor="#52c41a" /> : <CloseCircleTwoTone twoToneColor="#ff4d4f" />}
      <Typography.Text type={ok ? undefined : 'danger'}>{text}</Typography.Text>
    </Space>
  );
}

/** 簽署區檢核：甲乙各至少一框，並列出每一框的簽署方與頁碼。 */
function SignatureChecklist({
  signatureFields,
  withDetail,
}: {
  signatureFields: SignatureField[];
  withDetail?: boolean;
}) {
  const check = checkSignatureFields(signatureFields);
  return (
    <Space orientation="vertical" size={4}>
      <CheckLine ok={check.landlord > 0} text={`甲方（房東）簽名框 ${check.landlord} 個`} />
      <CheckLine ok={check.tenant > 0} text={`乙方（租客）簽名框 ${check.tenant} 個`} />
      {withDetail && signatureFields.length > 0 && (
        <Space size={4} wrap style={{ marginTop: 4 }}>
          {signatureFields.map((f) => (
            <Tag key={f.id} color={f.signer === 'landlord' ? 'blue' : 'orange'}>
              {f.signer === 'landlord' ? '甲方' : '乙方'}・第 {f.page + 1} 頁
            </Tag>
          ))}
        </Space>
      )}
    </Space>
  );
}

function money(value: number | null | undefined): string {
  return value == null ? '—' : `$${Number(value).toLocaleString()}`;
}

interface FormValues {
  landlordName?: string;
  landlordEmail?: string;
  tenantName?: string;
  tenantEmail?: string;
  rent?: number | null;
  deposit?: number | null;
  startDate?: dayjs.Dayjs | null;
  endDate?: dayjs.Dayjs | null;
  payDay?: number | null;
  extra?: string;
}

export default function ContractWizard({ id }: { id: string }) {
  const { message } = AntApp.useApp();
  const router = useRouter();
  const [contract, setContract] = useState<Contract | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [step, setStep] = useState(STEP_FIELDS);
  const [fields, setFields] = useState<ContractFields | null>(null);
  const [sigFields, setSigFields] = useState<SignatureField[]>([]);
  const [pdfVersion, setPdfVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [form] = Form.useForm<FormValues>();
  const initialised = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/contracts/${id}`);
      if (!res.ok) {
        if (!cancelled) setLoadFailed(true);
        return;
      }
      const { data } = (await res.json()) as { data: Contract };
      if (cancelled || initialised.current) return;
      initialised.current = true;
      setContract(data);
      setFields(data.fields);
      setSigFields(data.signature_fields);
      // 中斷後續作：落在第一個還沒完成的步驟（規格 §7 草稿保全）
      setStep(resumeStepIndex(data));
      form.setFieldsValue({
        landlordName: data.fields.landlordName,
        landlordEmail: data.fields.landlordEmail,
        tenantName: data.fields.tenantName,
        tenantEmail: data.fields.tenantEmail,
        rent: data.fields.rent,
        deposit: data.fields.deposit,
        startDate: data.fields.startDate ? dayjs(data.fields.startDate) : null,
        endDate: data.fields.endDate ? dayjs(data.fields.endDate) : null,
        payDay: data.fields.payDay,
        extra: data.fields.extra,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [id, form]);

  // 把表單當下的值併回合約欄位快照（物件相關欄位在建立草稿時已帶入，不在表單編輯）
  const readFields = useCallback((): ContractFields => {
    if (!contract) throw new Error('合約尚未載入');
    const v = form.getFieldsValue(true) as FormValues;
    return {
      ...contract.fields,
      landlordName: v.landlordName ?? '',
      landlordEmail: v.landlordEmail ?? '',
      tenantName: v.tenantName ?? '',
      tenantEmail: v.tenantEmail ?? '',
      rent: v.rent ?? null,
      deposit: v.deposit ?? null,
      startDate: v.startDate ? v.startDate.format('YYYY-MM-DD') : '',
      endDate: v.endDate ? v.endDate.format('YYYY-MM-DD') : '',
      payDay: v.payDay ?? null,
      extra: v.extra ?? '',
    };
  }, [contract, form]);

  // 每按「下一步」自動存草稿（規格 §7 五點基線第 5 點）
  const saveDraft = useCallback(
    async (next: ContractFields, nextSigFields: SignatureField[]): Promise<boolean> => {
      setSaving(true);
      try {
        const res = await fetch(`/api/contracts/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: next, signature_fields: nextSigFields }),
        });
        if (!res.ok) {
          message.error((await res.json()).error ?? '草稿儲存失敗');
          return false;
        }
        setPdfVersion((v) => v + 1); // 欄位改動要反映到 PDF 預覽
        return true;
      } finally {
        setSaving(false);
      }
    },
    [id, message]
  );

  if (loadFailed) {
    return (
      <Alert
        type="error"
        showIcon
        message="合約不存在"
        action={
          <Link href="/contracts">
            <Button size="small">回合約列表</Button>
          </Link>
        }
      />
    );
  }
  if (!contract || !fields) return <Spin style={{ display: 'block', margin: '64px auto' }} />;

  if (contract.status !== 'draft') {
    return (
      <Alert
        type="warning"
        showIcon
        message="此合約已送簽，不能再用建約流程編輯"
        description="修約請先撤回，再複製為新草稿重新編輯送簽。"
        action={
          <Link href={`/contracts/${contract.id}`}>
            <Button size="small" type="primary">
              前往合約詳情
            </Button>
          </Link>
        }
      />
    );
  }

  const state = { fields, signatureFields: sigFields };

  const goNext = async () => {
    const nextFields = step === STEP_FIELDS ? readFields() : fields;
    const blocked = nextStepBlockReason(step, { fields: nextFields, signatureFields: sigFields });
    if (blocked) {
      message.error(blocked);
      // 第②步同時觸發表單的欄位錯誤提示
      if (step === STEP_FIELDS) form.validateFields().catch(() => {});
      return;
    }
    setFields(nextFields);
    if (!(await saveDraft(nextFields, sigFields))) return;
    setStep(step + 1);
  };

  const goPrev = () => {
    if (step === STEP_FIELDS) setFields(readFields());
    setStep(step - 1);
  };

  const send = async () => {
    const blocked = sendBlockReason(state);
    if (blocked) {
      message.error(blocked);
      return;
    }
    if (!(await saveDraft(fields, sigFields))) return;
    setSending(true);
    const res = await fetch(`/api/contracts/${id}/send`, { method: 'POST' });
    const json = await res.json();
    setSending(false);
    if (!res.ok) {
      message.error(json.error ?? '送簽失敗');
      return;
    }
    message.success(json.data.mock ? '已送簽（mock 模式，未實際呼叫點點簽）' : '已送出至點點簽');
    router.push(`/contracts/${id}`);
  };

  const summaryItems = [
    { key: 'property', label: '物件', span: 2, children: fields.propertyName || '—' },
    { key: 'address', label: '地址', span: 2, children: fields.propertyAddress || '—' },
    {
      key: 'landlord',
      label: '甲方（房東）',
      children: `${fields.landlordName}（${fields.landlordEmail}）`,
    },
    {
      key: 'tenant',
      label: '乙方（租客）',
      children: `${fields.tenantName}（${fields.tenantEmail}）`,
    },
    { key: 'rent', label: '月租金', children: money(fields.rent) },
    { key: 'deposit', label: '押金', children: money(fields.deposit) },
    { key: 'lease', label: '租期', children: `${fields.startDate} ~ ${fields.endDate}` },
    { key: 'payDay', label: '每月付款日', children: fields.payDay != null ? `${fields.payDay} 日` : '—' },
    { key: 'template', label: '範本', span: 2, children: `${DEFAULT_TEMPLATE.name}（${DEFAULT_TEMPLATE.provider}）` },
    { key: 'extra', label: '其他約定事項', span: 2, children: fields.extra || '（無）' },
    {
      key: 'signature',
      label: '簽署區',
      span: 2,
      children: <SignatureChecklist signatureFields={sigFields} withDetail />,
    },
  ];

  return (
    <>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 12 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          建立合約 — 草稿 #{contract.id}
        </Typography.Title>
        <Link href="/contracts">
          <Button size="small">先離開（草稿已保留）</Button>
        </Link>
      </Space>

      <WizardStepsBar current={step} statuses={stepStatuses(step, state)} />

      {step === STEP_PROPERTY && (
        <Card size="small" style={{ maxWidth: 760 }}>
          <Descriptions
            column={1}
            size="small"
            style={{ marginBottom: 12 }}
            items={[
              { key: 'name', label: '物件', children: fields.propertyName || '—' },
              { key: 'address', label: '地址', children: fields.propertyAddress || '—' },
              { key: 'type', label: '型態', children: fields.propertyType || '—' },
              {
                key: 'size',
                label: '坪數',
                children: fields.propertySize != null ? `${fields.propertySize} 坪` : '—',
              },
              {
                key: 'equipment',
                label: '附屬設備',
                children: fields.equipment.length ? fields.equipment.join('、') : '—',
              },
            ]}
          />
          <TemplateNotice />
          <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}>
            物件資料在建立草稿時已帶入成快照，之後修改物件不影響這份合約。要換物件請回合約列表另建一份草稿。
          </Typography.Paragraph>
        </Card>
      )}

      {step === STEP_FIELDS && (
        <Card size="small" style={{ maxWidth: 760 }}>
          <Form form={form} layout="vertical" size="small" requiredMark>
            <Typography.Text strong>雙方資訊</Typography.Text>
            <Row gutter={12} style={{ marginTop: 8 }}>
              <Col span={12}>
                <Form.Item
                  name="landlordName"
                  label="甲方（房東）姓名"
                  rules={[{ required: true, message: '請輸入甲方姓名' }]}
                >
                  <Input />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  name="landlordEmail"
                  label="甲方 Email"
                  rules={[{ required: true, type: 'email', message: '請輸入有效的甲方 Email' }]}
                >
                  <Input />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  name="tenantName"
                  label="乙方（租客）姓名"
                  rules={[{ required: true, message: '請輸入乙方姓名' }]}
                >
                  <Input />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  name="tenantEmail"
                  label="乙方 Email"
                  rules={[{ required: true, type: 'email', message: '請輸入有效的乙方 Email' }]}
                >
                  <Input />
                </Form.Item>
              </Col>
            </Row>

            <Typography.Text strong>租金與租期</Typography.Text>
            <Row gutter={12} style={{ marginTop: 8 }}>
              <Col span={12}>
                <Form.Item name="rent" label="月租金（元）" rules={[{ required: true, message: '請輸入月租金' }]}>
                  <InputNumber min={0} step={1000} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="deposit" label="押金（元）">
                  <InputNumber min={0} step={1000} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="startDate" label="租期起日" rules={[{ required: true, message: '請選擇租期起日' }]}>
                  <DatePicker style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="endDate" label="租期迄日" rules={[{ required: true, message: '請選擇租期迄日' }]}>
                  <DatePicker style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="payDay" label="每月付款日">
                  <InputNumber min={1} max={28} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>
            <Form.Item name="extra" label="其他約定事項（第八條）" style={{ marginBottom: 0 }}>
              <Input.TextArea rows={3} placeholder="無則留空" />
            </Form.Item>
          </Form>
        </Card>
      )}

      {step === STEP_SIGNATURE && (
        <Row gutter={16}>
          <Col span={17}>
            <Card size="small" title="在預覽上為甲乙雙方各拖放至少一個簽名框">
              <SignatureFieldEditor
                pdfUrl={`/api/contracts/${id}/pdf?v=${pdfVersion}`}
                value={sigFields}
                onChange={setSigFields}
              />
            </Card>
          </Col>
          <Col span={7}>
            <Card size="small" title="簽署區檢核">
              <SignatureChecklist signatureFields={sigFields} withDetail />
            </Card>
          </Col>
        </Row>
      )}

      {step === STEP_CONFIRM && (
        <Card size="small" style={{ maxWidth: 860 }}>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="乙方先簽"
            description={TENANT_FIRST_NOTICE}
          />
          <Descriptions column={2} size="small" bordered items={summaryItems} />
        </Card>
      )}

      <Space style={{ marginTop: 16 }}>
        {step > STEP_PROPERTY && (
          <Button icon={<LeftOutlined />} onClick={goPrev} disabled={saving || sending}>
            上一步
          </Button>
        )}
        {step < STEP_CONFIRM && (
          <Button type="primary" loading={saving} onClick={goNext}>
            下一步 <RightOutlined />
          </Button>
        )}
        {step === STEP_CONFIRM && (
          <Button type="primary" icon={<SendOutlined />} loading={saving || sending} onClick={send}>
            確認送簽
          </Button>
        )}
      </Space>
    </>
  );
}
