'use client';

// 合約詳情頁（規格 §8）：分頁型版面。
// 頁首＝身分（編號／狀態／物件與乙方）＋依狀態的操作；其下是簽署中才有的狀態列；
// 內容分四個 tab：合約內容／歷程／文件／關聯合約。
// 草稿不在此頁編輯欄位，編輯一律回建約 wizard（規格 §7、MIL-12 決議）。

import { use, useCallback, useEffect, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Popconfirm,
  Row,
  Space,
  Steps,
  Tabs,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import {
  ArrowRightOutlined,
  CopyOutlined,
  DownloadOutlined,
  EditOutlined,
  FileDoneOutlined,
  FileProtectOutlined,
  ReloadOutlined,
  RollbackOutlined,
} from '@ant-design/icons';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type {
  Contract,
  ContractEvent,
  ContractFile,
  ContractRelations,
  ContractStatus,
} from '@/lib/types';
import { CONTRACT_STATUS_LABELS } from '@/lib/types';
import { currentSigner } from '@/lib/signing';
import {
  contractChainNodes,
  contractEventEntries,
  contractFileDownloadHref,
  contractFileRows,
  detailActions,
  type ContractFileRow,
  type DetailAction,
} from '@/lib/contract-detail';
import SignatureFieldEditor from '@/components/SignatureFieldEditor';

const STATUS_COLORS: Record<ContractStatus, string> = {
  draft: 'default',
  awaiting_tenant: 'processing',
  awaiting_landlord: 'processing',
  completed: 'success',
  declined: 'error',
  voided: 'warning',
};

const STEP_INDEX: Partial<Record<ContractStatus, number>> = {
  awaiting_tenant: 0,
  awaiting_landlord: 1,
  completed: 2,
};

const FILE_ICONS = {
  signed_pdf: <FileDoneOutlined />,
  audit_trail: <FileProtectOutlined />,
};

function formatSize(bytes: number | null): string {
  if (bytes == null) return '';
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

function ContractDetail({ id }: { id: string }) {
  const { message } = AntApp.useApp();
  const router = useRouter();
  const [contract, setContract] = useState<Contract | null>(null);
  const [relations, setRelations] = useState<ContractRelations | null>(null);
  const [events, setEvents] = useState<ContractEvent[]>([]);
  const [files, setFiles] = useState<ContractFile[]>([]);
  const [mockMode, setMockMode] = useState(false);
  // 連同取得當下的狀態一起存：狀態轉移後舊連結不再屬於當前待簽方，直接失效
  const [signLinkState, setSignLinkState] = useState<{ forStatus: ContractStatus; link: string } | null>(null);
  const [linkLoading, setLinkLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [refetching, setRefetching] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/contracts/${id}`);
    if (!res.ok) {
      message.error('合約不存在');
      router.push('/contracts');
      return;
    }
    const json = await res.json();
    setContract(json.data);
    setRelations(json.relations ?? null);

    // 歷程與文件跟著合約一起更新，webhook 推進狀態後三者才會一致
    const [eventsJson, filesJson] = await Promise.all([
      fetch(`/api/contracts/${id}/events`).then((r) => (r.ok ? r.json() : { data: [] })),
      fetch(`/api/contracts/${id}/files`).then((r) => (r.ok ? r.json() : { data: [] })),
    ]);
    setEvents(eventsJson.data ?? []);
    setFiles(filesJson.data ?? []);
  }, [id, message, router]);

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

  const act = useCallback(
    async (path: string, body?: object) => {
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
    },
    [message]
  );

  if (!contract) return null;
  const isDraft = contract.status === 'draft';
  const isSigning = contract.status === 'awaiting_tenant' || contract.status === 'awaiting_landlord';
  const signer = currentSigner(contract);
  const signLink = signLinkState?.forStatus === contract.status ? signLinkState.link : null;
  const eventEntries = contractEventEntries(events);
  const fileRows = contractFileRows(contract, files, { mock: mockMode });
  const chain = contractChainNodes(contract, relations);

  const voidContract = async () => {
    const data = await act(`/api/contracts/${id}/void`);
    if (data) {
      message.success('已撤回');
      load();
    }
  };

  const copyAsDraft = async () => {
    const data = await act(`/api/contracts/${id}/copy`);
    if (data) {
      message.success('已複製為新草稿');
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

  // 補抓：完成當下抓檔失敗（點點簽暫時性錯誤、連結過期）時的補救
  const refetchFiles = async () => {
    setRefetching(true);
    const res = await fetch(`/api/contracts/${id}/files`, { method: 'POST' });
    const json = await res.json();
    setRefetching(false);
    if (!res.ok) {
      message.error(json.error ?? '補抓文件失敗');
      return;
    }
    setFiles(json.data.files ?? []);
    const failed = (json.data.results ?? []).filter((r: { ok: boolean }) => !r.ok);
    if (failed.length) message.warning('部分文件仍保存失敗，詳見下方錯誤訊息');
    else message.success('已補抓文件');
  };

  const renderAction = (action: DetailAction) => {
    switch (action.key) {
      case 'edit':
        return (
          <Link key={action.key} href={`/contracts/${id}/edit`}>
            <Button type="primary" icon={<EditOutlined />}>
              {action.label}
            </Button>
          </Link>
        );
      case 'void':
        return (
          <Popconfirm key={action.key} title={action.confirm} onConfirm={voidContract}>
            <Button danger icon={<RollbackOutlined />}>
              {action.label}
            </Button>
          </Popconfirm>
        );
      case 'signed_pdf':
        return (
          <Button
            key={action.key}
            type="primary"
            icon={<DownloadOutlined />}
            href={contractFileDownloadHref(contract.id, 'signed_pdf')}
          >
            {action.label}
          </Button>
        );
      case 'audit_trail':
        return (
          <Button
            key={action.key}
            icon={<DownloadOutlined />}
            href={contractFileDownloadHref(contract.id, 'audit_trail')}
          >
            {action.label}
          </Button>
        );
      case 'copy':
        return (
          <Button key={action.key} type="primary" icon={<CopyOutlined />} onClick={copyAsDraft}>
            {action.label}
          </Button>
        );
    }
  };

  const summary = (
    <Descriptions
      column={1}
      size="small"
      items={[
        { key: 'property', label: '物件', children: contract.fields.propertyName },
        { key: 'address', label: '地址', children: contract.fields.propertyAddress },
        {
          key: 'landlord',
          label: '甲方',
          children: `${contract.fields.landlordName}（${contract.fields.landlordEmail}）`,
        },
        {
          key: 'tenant',
          label: '乙方',
          children: `${contract.fields.tenantName}（${contract.fields.tenantEmail}）`,
        },
        {
          key: 'rent',
          label: '月租金',
          children: contract.fields.rent != null ? `$${contract.fields.rent.toLocaleString()}` : '—',
        },
        {
          key: 'deposit',
          label: '押金',
          children: contract.fields.deposit != null ? `$${contract.fields.deposit.toLocaleString()}` : '—',
        },
        {
          key: 'lease',
          label: '租期',
          children: `${contract.fields.startDate} ~ ${contract.fields.endDate}`,
        },
        {
          key: 'template',
          label: '範本',
          children: contract.fields.templateVersion
            ? `住宅租賃契約 v${contract.fields.templateVersion}（平台提供）`
            : '住宅租賃契約（未綁定版本，MIL-26 之前建立）',
        },
        {
          key: 'clauses',
          label: '選用條款',
          children: contract.fields.clauses?.length
            ? contract.fields.clauses.map((c) => c.title).join('、')
            : '無',
        },
        {
          key: 'extra',
          label: '其他約定事項',
          children: contract.fields.extra || '無',
        },
      ]}
    />
  );

  const fileAction = (row: ContractFileRow) => {
    switch (row.state) {
      case 'saved':
        return (
          <Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {formatSize(row.file?.byte_size ?? null)}
            </Typography.Text>
            <Button size="small" icon={<DownloadOutlined />} href={row.downloadHref}>
              下載
            </Button>
          </Space>
        );
      case 'failed':
        return (
          <Button size="small" icon={<ReloadOutlined />} loading={refetching} onClick={refetchFiles}>
            補抓
          </Button>
        );
      case 'pending':
        return contract.status === 'completed' ? (
          <Button size="small" icon={<ReloadOutlined />} loading={refetching} onClick={refetchFiles}>
            補抓
          </Button>
        ) : (
          <Typography.Text type="secondary">尚未產生</Typography.Text>
        );
      case 'unavailable':
        return <Typography.Text type="secondary">不適用</Typography.Text>;
    }
  };

  return (
    <>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 8 }}>
        <Space wrap>
          <Typography.Title level={4} style={{ margin: 0 }}>
            合約 #{contract.id}
          </Typography.Title>
          <Tag color={STATUS_COLORS[contract.status]}>{CONTRACT_STATUS_LABELS[contract.status]}</Tag>
          {mockMode && <Tag color="purple">mock 模式</Tag>}
          <Typography.Text type="secondary">
            {contract.fields.propertyName}・{contract.fields.tenantName}
          </Typography.Text>
        </Space>
        <Space>{detailActions(contract.status, { mock: mockMode }).map(renderAction)}</Space>
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
            <Space style={{ marginTop: 12 }} wrap>
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

      <Tabs
        defaultActiveKey="content"
        items={[
          {
            key: 'content',
            label: '合約內容',
            children: (
              <Row gutter={16}>
                <Col span={9}>
                  <Card title="合約摘要" size="small">
                    {summary}
                    {isDraft && (
                      <Alert
                        type="info"
                        showIcon
                        style={{ marginTop: 12 }}
                        message="草稿的欄位與簽署區設定都在建約流程內編輯，請按右上「繼續編輯」。"
                      />
                    )}
                  </Card>
                </Col>
                <Col span={15}>
                  <Card title={isDraft ? '合約預覽（唯讀）' : '合約內容'} size="small">
                    <SignatureFieldEditor
                      pdfUrl={`/api/contracts/${id}/pdf`}
                      value={contract.signature_fields}
                      readOnly
                    />
                  </Card>
                </Col>
              </Row>
            ),
          },
          {
            key: 'history',
            label: '歷程',
            children: (
              <Row>
                <Col span={16}>
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 24 }}
                    message="此為活動歷程（只記里程碑事件）"
                    description="草稿編輯與下載／查看不記錄；法律舉證以點點簽 Audit Trail File 為準（ADR-0007）。"
                  />
                  {eventEntries.length === 0 ? (
                    <Empty description="尚無歷程事件" />
                  ) : (
                    <Timeline
                      mode="start"
                      items={eventEntries.map((e) => ({
                        key: e.key,
                        color: e.color,
                        title: e.time,
                        content: (
                          <>
                            <Typography.Text strong>{e.label}</Typography.Text>
                            <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                              行為者：{e.actorLabel}
                            </Typography.Text>
                            {e.note && (
                              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                {e.note}
                              </Typography.Text>
                            )}
                          </>
                        ),
                      }))}
                    />
                  )}
                </Col>
              </Row>
            ),
          },
          {
            key: 'files',
            label: '文件',
            children: (
              <Row>
                <Col span={14}>
                  <Space orientation="vertical" size={16} style={{ width: '100%' }}>
                    {fileRows.map((row) => (
                      <div key={row.kind} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                        <span style={{ fontSize: 18, marginTop: 2 }}>{FILE_ICONS[row.kind]}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          {row.label}
                          <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                            {row.hint}
                          </Typography.Text>
                          {row.state === 'failed' && row.error && (
                            <Typography.Text type="danger" style={{ display: 'block', fontSize: 12 }}>
                              {row.error}
                            </Typography.Text>
                          )}
                        </div>
                        {fileAction(row)}
                      </div>
                    ))}
                  </Space>
                </Col>
              </Row>
            ),
          },
          {
            key: 'relations',
            label: '關聯合約',
            children:
              chain.length === 0 ? (
                <Empty description="無衍生關聯（僅撤回修約路徑會記錄，ADR-0006）" />
              ) : (
                <Space align="center" size={16} wrap>
                  {chain.map((node, i) => (
                    <Space key={node.id} align="center" size={16}>
                      {i > 0 && <ArrowRightOutlined />}
                      <Card
                        size="small"
                        style={{ width: 220, borderColor: node.role === 'self' ? '#1677ff' : undefined }}
                      >
                        {node.href ? (
                          <Link href={node.href}>合約 #{node.id}</Link>
                        ) : (
                          <Typography.Text strong>合約 #{node.id}</Typography.Text>
                        )}{' '}
                        <Tag color={STATUS_COLORS[node.status]}>{CONTRACT_STATUS_LABELS[node.status]}</Tag>
                        <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                          {node.note}
                        </Typography.Text>
                      </Card>
                    </Space>
                  ))}
                </Space>
              ),
          },
        ]}
      />
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
