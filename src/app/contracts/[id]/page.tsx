'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
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
  Popconfirm,
  Row,
  Space,
  Steps,
  Tag,
  Typography,
} from 'antd';
import { SendOutlined, DownloadOutlined, CopyOutlined, RollbackOutlined } from '@ant-design/icons';
import { useRouter } from 'next/navigation';
import dayjs from 'dayjs';
import type { Contract, ContractStatus, SignatureField } from '@/lib/types';
import { CONTRACT_STATUS_LABELS } from '@/lib/types';
import { currentSigner } from '@/lib/signing';
import SignatureFieldEditor from '@/components/SignatureFieldEditor';

const STEP_INDEX: Partial<Record<ContractStatus, number>> = {
  awaiting_tenant: 0,
  awaiting_landlord: 1,
  completed: 2,
};

function ContractDetail({ id }: { id: string }) {
  const { message } = AntApp.useApp();
  const router = useRouter();
  const [contract, setContract] = useState<Contract | null>(null);
  const [mockMode, setMockMode] = useState(false);
  const [sigFields, setSigFields] = useState<SignatureField[]>([]);
  const [pdfVersion, setPdfVersion] = useState(0);
  const [sending, setSending] = useState(false);
  // 連同取得當下的狀態一起存：狀態轉移後舊連結不再屬於當前待簽方，直接失效
  const [signLinkState, setSignLinkState] = useState<{ forStatus: ContractStatus; link: string } | null>(null);
  const [linkLoading, setLinkLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [form] = Form.useForm();
  const loadedOnce = useRef(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/contracts/${id}`);
    if (!res.ok) {
      message.error('合約不存在');
      router.push('/contracts');
      return;
    }
    const json = await res.json();
    const c: Contract = json.data;
    setContract(c);
    setSigFields(c.signature_fields);
    if (!loadedOnce.current) {
      loadedOnce.current = true;
      form.setFieldsValue({
        ...c.fields,
        startDate: c.fields.startDate ? dayjs(c.fields.startDate) : null,
        endDate: c.fields.endDate ? dayjs(c.fields.endDate) : null,
      });
    }
  }, [id, form, message, router]);

  useEffect(() => {
    load();
    fetch('/api/meta')
      .then((r) => r.json())
      .then((j) => setMockMode(j.data.mock));
  }, [load]);

  // 簽署中每 5 秒輪詢一次，讓 webhook 更新反映到畫面
  useEffect(() => {
    if (!contract || (contract.status !== 'awaiting_tenant' && contract.status !== 'awaiting_landlord'))
      return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [contract, load]);

  if (!contract) return null;
  const isDraft = contract.status === 'draft';
  const isSigning = contract.status === 'awaiting_tenant' || contract.status === 'awaiting_landlord';
  const signer = currentSigner(contract);
  const signLink = signLinkState?.forStatus === contract.status ? signLinkState.link : null;

  const collectFields = () => {
    const v = form.getFieldsValue();
    return {
      ...v,
      startDate: v.startDate ? v.startDate.format('YYYY-MM-DD') : '',
      endDate: v.endDate ? v.endDate.format('YYYY-MM-DD') : '',
    };
  };

  const save = async (silent = false) => {
    const res = await fetch(`/api/contracts/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: collectFields(), signature_fields: sigFields }),
    });
    if (!res.ok) {
      message.error((await res.json()).error ?? '儲存失敗');
      return false;
    }
    if (!silent) message.success('已儲存');
    setPdfVersion((v) => v + 1); // 觸發 PDF 預覽重載
    return true;
  };

  const send = async () => {
    if (!(await save(true))) return;
    setSending(true);
    const res = await fetch(`/api/contracts/${id}/send`, { method: 'POST' });
    const json = await res.json();
    setSending(false);
    if (!res.ok) {
      message.error(json.error ?? '送簽失敗');
      return;
    }
    message.success(json.data.mock ? '已送簽（mock 模式，未實際呼叫點點簽）' : '已送出至點點簽');
    load();
  };

  const act = async (path: string, body?: object) => {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    if (!res.ok) {
      message.error(json.error ?? '操作失敗');
      return null;
    }
    return json.data;
  };

  const copyAsDraft = async () => {
    const data = await act(`/api/contracts/${id}/copy`);
    if (data) {
      message.success('已複製為新草稿');
      loadedOnce.current = false;
      router.push(`/contracts/${data.id}`);
    }
  };

  const fetchSignLink = async () => {
    setLinkLoading(true);
    const res = await fetch(`/api/contracts/${id}/sign-link`);
    const json = await res.json();
    setLinkLoading(false);
    if (!res.ok) {
      message.error(json.error ?? '取得簽署連結失敗');
      return;
    }
    setSignLinkState({ forStatus: contract.status, link: json.data.sign_link });
  };

  const resend = async () => {
    setResending(true);
    const data = await act(`/api/contracts/${id}/resend`);
    setResending(false);
    if (data) message.success(`已重寄簽署通知至 ${data.resent_to}`);
  };

  const mockAdvance = async (event: string, label: string) => {
    const data = await act('/api/mock/advance', { contract_id: Number(id), event });
    if (data) {
      message.success(label);
      load();
    }
  };

  const pdfUrl = `/api/contracts/${id}/pdf?v=${pdfVersion}`;

  return (
    <>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16 }}>
        <Space>
          <Typography.Title level={4} style={{ margin: 0 }}>
            合約 #{contract.id}
          </Typography.Title>
          <Tag>{CONTRACT_STATUS_LABELS[contract.status]}</Tag>
          {mockMode && <Tag color="purple">mock 模式</Tag>}
        </Space>
        <Space>
          {isDraft && (
            <>
              <Button onClick={() => save()}>儲存</Button>
              <Button type="primary" icon={<SendOutlined />} loading={sending} onClick={send}>
                送簽
              </Button>
            </>
          )}
          {isSigning && (
            <Popconfirm title="撤回後需複製為新草稿重新送簽，確定？" onConfirm={() => act(`/api/contracts/${id}/void`).then((d) => d && load())}>
              <Button danger icon={<RollbackOutlined />}>
                撤回
              </Button>
            </Popconfirm>
          )}
          {contract.status === 'completed' && (
            <Button type="primary" icon={<DownloadOutlined />} href={`/api/contracts/${id}/signed-pdf`}>
              下載已簽 PDF
            </Button>
          )}
          {(contract.status === 'declined' || contract.status === 'voided') && (
            <Button type="primary" icon={<CopyOutlined />} onClick={copyAsDraft}>
              複製為新草稿
            </Button>
          )}
        </Space>
      </Space>

      {!isDraft && (
        <Card size="small" style={{ marginBottom: 16 }}>
          {contract.status === 'declined' ? (
            <Alert type="error" message="乙方已拒簽" description={contract.declined_reason} showIcon />
          ) : contract.status === 'voided' ? (
            <Alert type="warning" message="此合約已撤回" showIcon />
          ) : (
            <Steps
              size="small"
              current={STEP_INDEX[contract.status] ?? 0}
              items={[{ title: '待乙方（租客）簽署' }, { title: '待甲方（房東）簽署' }, { title: '完成' }]}
            />
          )}
          {contract.dottedsign_task_id && (
            <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
              點點簽任務 ID：{contract.dottedsign_task_id}
            </Typography.Text>
          )}
          {!mockMode && isSigning && signer && (
            <div style={{ marginTop: 12 }}>
              <Space wrap>
                <Typography.Text type="secondary">
                  目前待簽：{signer.role === 'tenant' ? '乙方' : '甲方'} {signer.name}（{signer.email}）
                </Typography.Text>
                <Button size="small" loading={linkLoading} onClick={fetchSignLink}>
                  取得簽署連結
                </Button>
                <Button size="small" loading={resending} onClick={resend}>
                  重寄簽署通知
                </Button>
              </Space>
              {signLink && (
                <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 4, maxWidth: 720 }}>
                  <Typography.Link href={signLink} target="_blank" ellipsis style={{ flex: 1, minWidth: 0 }}>
                    {signLink}
                  </Typography.Link>
                  <Typography.Text copyable={{ text: signLink, tooltips: ['複製連結', '已複製'] }} />
                </div>
              )}
            </div>
          )}
          {mockMode && isSigning && (
            <Space style={{ marginTop: 12 }}>
              <Typography.Text type="secondary">模擬 webhook：</Typography.Text>
              {contract.status === 'awaiting_tenant' && (
                <>
                  <Button size="small" onClick={() => mockAdvance('signed', '已模擬乙方簽署')}>
                    模擬乙方簽署
                  </Button>
                  <Button size="small" danger onClick={() => mockAdvance('declined', '已模擬乙方拒簽')}>
                    模擬乙方拒簽
                  </Button>
                </>
              )}
              {contract.status === 'awaiting_landlord' && (
                <Button size="small" onClick={() => mockAdvance('completed', '已模擬甲方簽署，合約完成')}>
                  模擬甲方簽署完成
                </Button>
              )}
            </Space>
          )}
        </Card>
      )}

      <Row gutter={24}>
        <Col span={isDraft ? 10 : 8}>
          {isDraft ? (
            <Card title="合約欄位（範本條款固定，僅編輯欄位）" size="small">
              <Form form={form} layout="vertical" size="small">
                <Row gutter={12}>
                  <Col span={12}>
                    <Form.Item name="landlordName" label="甲方（房東）姓名" rules={[{ required: true }]}>
                      <Input />
                    </Form.Item>
                  </Col>
                  <Col span={12}>
                    <Form.Item name="landlordEmail" label="甲方 Email" rules={[{ required: true, type: 'email' }]}>
                      <Input />
                    </Form.Item>
                  </Col>
                  <Col span={12}>
                    <Form.Item name="tenantName" label="乙方（租客）姓名" rules={[{ required: true }]}>
                      <Input />
                    </Form.Item>
                  </Col>
                  <Col span={12}>
                    <Form.Item name="tenantEmail" label="乙方 Email" rules={[{ required: true, type: 'email' }]}>
                      <Input />
                    </Form.Item>
                  </Col>
                  <Col span={12}>
                    <Form.Item name="rent" label="月租金（元）" rules={[{ required: true }]}>
                      <InputNumber min={0} step={1000} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col span={12}>
                    <Form.Item name="deposit" label="押金（元）">
                      <InputNumber min={0} step={1000} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col span={12}>
                    <Form.Item name="startDate" label="租期起日" rules={[{ required: true }]}>
                      <DatePicker style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col span={12}>
                    <Form.Item name="endDate" label="租期迄日" rules={[{ required: true }]}>
                      <DatePicker style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col span={12}>
                    <Form.Item name="payDay" label="每月付款日">
                      <InputNumber min={1} max={28} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                </Row>
                <Form.Item name="extra" label="其他約定事項（第八條）">
                  <Input.TextArea rows={3} placeholder="無則留空" />
                </Form.Item>
              </Form>
              <Alert
                type="info"
                showIcon
                message="儲存後右側預覽會更新；請在預覽上為甲乙雙方各拖放至少一個簽名框再送簽。"
              />
            </Card>
          ) : (
            <Card title="合約資料" size="small">
              <Descriptions column={1} size="small">
                <Descriptions.Item label="物件">{contract.fields.propertyName}</Descriptions.Item>
                <Descriptions.Item label="地址">{contract.fields.propertyAddress}</Descriptions.Item>
                <Descriptions.Item label="甲方">
                  {contract.fields.landlordName}（{contract.fields.landlordEmail}）
                </Descriptions.Item>
                <Descriptions.Item label="乙方">
                  {contract.fields.tenantName}（{contract.fields.tenantEmail}）
                </Descriptions.Item>
                <Descriptions.Item label="月租金">
                  {contract.fields.rent != null ? `$${contract.fields.rent.toLocaleString()}` : '—'}
                </Descriptions.Item>
                <Descriptions.Item label="租期">
                  {contract.fields.startDate} ~ {contract.fields.endDate}
                </Descriptions.Item>
              </Descriptions>
            </Card>
          )}
        </Col>
        <Col span={isDraft ? 14 : 16}>
          <Card title={isDraft ? '合約預覽與簽署區域設定' : '合約內容'} size="small">
            <SignatureFieldEditor
              pdfUrl={pdfUrl}
              value={sigFields}
              onChange={setSigFields}
              readOnly={!isDraft}
            />
          </Card>
        </Col>
      </Row>
    </>
  );
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <AntApp>
      <ContractDetail id={id} />
    </AntApp>
  );
}
