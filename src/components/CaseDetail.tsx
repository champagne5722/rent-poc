'use client';

import { useState } from 'react';
import { App as AntApp, Button, Card, Collapse, Descriptions, Divider, Flex, Form, Input, Modal, Tag, Typography } from 'antd';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import NextStep from '@/components/page/NextStep';
import DetailPage from '@/components/page/DetailPage';
import ListTable from '@/components/page/ListTable';
import EmptyState from '@/components/page/EmptyState';
import type { CaseContractRow, CaseEventRecord, CaseMemberRecord } from '@/lib/case-store';
import type { CaseDetailData } from '@/lib/case-detail-load';
import { caseNextStep } from '@/lib/case-next-step';
import { isTenantRelation } from '@/lib/cases';
import { caseKindLabel, eventDescription, formatTaipei, leaseBusinessTypeLabel, leasePeriodLabel, monthlyRentLabel } from '@/lib/case-display';
import { CASE_MEMBER_RELATION_LABELS } from '@/lib/labels/case-labels';
import { shortUlid } from '@/lib/pg/ulid';
import type { ContractStatus } from '@/lib/types';
import CaseLedgerPanel from './CaseLedgerPanel';
import StatusTag from './StatusTag';

// 案件詳情（MIL-115、MIL-184）：套用詳情頁版型。資料由 server component 載入後傳進來，這裡只管版面與操作。
// 由上而下：頁首（案件狀態）、下一步、案件成員、合約、帳務設定（可收合）、案件事件（可收合）。右側是案件屬性。
// readOnly 是案件成員的唯讀版本，屋主從資產總覽進入（MIL-94）。主辦組織的管理員與業務人員另有加入共同承租人。
// 加入成員或更新 email 成功後呼叫 router.refresh()，讓 server component 重新載入資料。

export interface CaseDetailProps {
  caseId: string;
  detail: CaseDetailData;
  readOnly?: boolean;
  backHref: string;
  backLabel?: string;
}

export default function CaseDetail(props: CaseDetailProps) {
  return (
    <AntApp>
      <CaseDetailBody {...props} />
    </AntApp>
  );
}

function CaseDetailBody({ caseId, detail, readOnly = false, backHref, backLabel = '返回案件列表' }: CaseDetailProps) {
  const { message } = AntApp.useApp();
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [form] = Form.useForm<{ name: string; email: string }>();
  // 更新承租人 email（MIL-121）：正在更新哪一位成員。null 表示 Modal 關閉
  const [replacing, setReplacing] = useState<CaseMemberRecord | null>(null);
  const [replacingBusy, setReplacingBusy] = useState(false);
  const [replaceForm] = Form.useForm<{ email: string }>();

  const { case: record } = detail;
  const canEdit = !readOnly && detail.isHost && detail.canManageMembers;
  const showLedger = detail.isHost || readOnly;
  const next = caseNextStep({ state: record.state, isHost: detail.isHost, hasCurrentContract: Boolean(record.currentContractId) });
  const activeMembers = detail.members.filter((m) => m.validUntil === null).length;

  const addMember = async (values: { name: string; email: string }) => {
    setAdding(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const json = await res.json();
      if (!res.ok) {
        message.error(json.error ?? '加入失敗');
        return;
      }
      message.success('已加入共同承租人');
      form.resetFields();
      router.refresh();
    } finally {
      setAdding(false);
    }
  };

  const replaceEmail = async (values: { email: string }) => {
    if (!replacing) return;
    setReplacingBusy(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/members/${replacing.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: values.email }),
      });
      const json = await res.json();
      if (!res.ok) {
        message.error(json.error ?? '更新失敗');
        return;
      }
      message.success('已更新 email，舊 email 已失效');
      setReplacing(null);
      replaceForm.resetFields();
      router.refresh();
    } finally {
      setReplacingBusy(false);
    }
  };

  const businessType = leaseBusinessTypeLabel(record.caseKind, record.businessType);
  const collapsibleItems = [
    // 帳務設定（MIL-123）：主辦組織與唯讀的屋主版本看得到。能不能編輯由 API 回傳的旗標決定
    ...(showLedger ? [{ key: 'ledger', label: '帳務設定', children: <CaseLedgerPanel caseId={caseId} /> }] : []),
    ...(detail.events.length > 0
      ? [
          {
            key: 'events',
            label: `案件事件 ${detail.events.length}`,
            children: (
              <ListTable<CaseEventRecord>
                table={{
                  rowKey: 'id',
                  dataSource: detail.events,
                  columns: [
                    { title: '時間', width: 160, render: (_, e) => formatTaipei(e.occurredAt) },
                    { title: '事件', render: (_, e) => eventDescription(e) },
                  ],
                }}
                emptyNode={<EmptyState description="沒有可顯示的案件事件" />}
              />
            ),
          },
        ]
      : []),
  ];

  return (
    <DetailPage
      header={{
        title: record.title || '（未命名案件）',
        tag: (
          <Flex gap="small" align="center">
            <StatusTag kind="case" value={record.state} />
            {readOnly && <Tag>唯讀</Tag>}
          </Flex>
        ),
        back: { href: backHref, label: backLabel },
      }}
      nextStep={
        <NextStep
          headline={next.headline}
          owner={next.owner}
          detail={next.detail}
          tone={next.tone}
          actions={
            next.linkToContract && record.currentContractId ? (
              <Link href={`/contracts/${record.currentContractId}`}>
                <Button>前往目前合約</Button>
              </Link>
            ) : undefined
          }
        />
      }
      // 帳務設定與案件事件本身很高，放在兩欄下方橫跨全寬，才不會讓主要內容欄比側欄高出一截
      wide={collapsibleItems.length > 0 ? <Collapse items={collapsibleItems} defaultActiveKey={showLedger ? ['ledger'] : []} /> : undefined}
      aside={
        <Card size="small" title="案件屬性">
          <Descriptions
            column={1}
            size="small"
            items={[
              { key: 'kind', label: '案件種類', children: caseKindLabel(record.caseKind, record.businessType) },
              ...(businessType ? [{ key: 'type', label: '業務類型', children: businessType }] : []),
              { key: 'period', label: '租期', children: leasePeriodLabel(record.leaseStart, record.leaseEnd) },
              { key: 'rent', label: '月租金', children: monthlyRentLabel(record.monthlyRent) },
              { key: 'social', label: '社宅代管', children: record.socialHousing ? '是' : '否' },
              { key: 'org', label: '主辦', children: detail.isHost ? '本組織' : (detail.orgName ?? '—') },
              { key: 'created', label: '建立時間', children: formatTaipei(record.createdAt) },
            ]}
          />
        </Card>
      }
    >
      {(detail.members.length > 0 || canEdit) && (
        <Card size="small" title={`案件成員 ${activeMembers}`}>
          <Flex vertical gap="middle">
            <ListTable<CaseMemberRecord>
              table={{
                rowKey: 'id',
                dataSource: detail.members,
                scroll: { x: 'max-content' },
                columns: [
                  { title: '關係', width: 110, render: (_, m) => CASE_MEMBER_RELATION_LABELS[m.relation] },
                  { title: '姓名', dataIndex: 'displayName' },
                  { title: 'Email', dataIndex: 'email' },
                  { title: '加入時間', width: 150, render: (_, m) => formatTaipei(m.validFrom) },
                  { title: '狀態', width: 80, render: (_, m) => (m.validUntil === null ? '有效' : '已結束') },
                  ...(canEdit
                    ? [
                        {
                          title: '操作',
                          width: 110,
                          fixed: 'right' as const,
                          render: (_: unknown, m: CaseMemberRecord) =>
                            m.validUntil === null && isTenantRelation(m.relation) ? (
                              <Button type="link" size="small" onClick={() => setReplacing(m)}>
                                更新 email
                              </Button>
                            ) : null,
                        },
                      ]
                    : []),
                ],
              }}
              emptyNode={<EmptyState description="沒有可顯示的成員" />}
            />
            {canEdit && (
              <>
                <Divider />
                <Typography.Text strong>加入共同承租人</Typography.Text>
                <Form form={form} layout="inline" onFinish={(values) => void addMember(values)}>
                  <Form.Item name="name" label="姓名" rules={[{ required: true, message: '請填寫姓名' }]}>
                    <Input />
                  </Form.Item>
                  <Form.Item name="email" label="Email" rules={[{ required: true, type: 'email', message: '請填寫有效的 email' }]}>
                    <Input />
                  </Form.Item>
                  <Button type="primary" htmlType="submit" loading={adding}>
                    加入
                  </Button>
                </Form>
              </>
            )}
          </Flex>
          <Modal
            open={replacing !== null}
            title={`更新${replacing ? CASE_MEMBER_RELATION_LABELS[replacing.relation] : ''}的 email`}
            okText="更新 email"
            cancelText="取消"
            confirmLoading={replacingBusy}
            onOk={() => replaceForm.submit()}
            onCancel={() => setReplacing(null)}
            destroyOnHidden
          >
            <Flex vertical gap="small">
              <Typography.Text>
                更新後，{replacing?.displayName}目前的 email 立即失去這個案件的存取權，新的 email 取得相同的關係。合約內記載的 email 不會改變。
              </Typography.Text>
              <Form form={replaceForm} layout="vertical" onFinish={(values) => void replaceEmail(values)}>
                <Form.Item name="email" label="新的 email" rules={[{ required: true, type: 'email', message: '請填寫有效的 email' }]}>
                  <Input autoComplete="off" />
                </Form.Item>
              </Form>
            </Flex>
          </Modal>
        </Card>
      )}

      {detail.contracts.length > 0 && (
        <Card size="small" title={`合約 ${detail.contracts.length}`}>
          <ListTable<CaseContractRow>
            table={{
              rowKey: 'id',
              dataSource: detail.contracts,
              columns: [
                {
                  title: 'ID 末碼',
                  width: 100,
                  render: (_, c) => (detail.isHost ? <Link href={`/contracts/${c.id}`}>{shortUlid(c.id)}</Link> : shortUlid(c.id)),
                },
                { title: '狀態', width: 110, render: (_, c) => <StatusTag kind="contract" value={c.status as ContractStatus} /> },
                { title: '目前合約', width: 100, render: (_, c) => (c.isCurrent ? <Tag color="processing">目前</Tag> : '—') },
                { title: '衍生自', width: 100, render: (_, c) => (c.derivedFrom ? shortUlid(c.derivedFrom) : '—') },
                { title: '建立時間', width: 150, render: (_, c) => formatTaipei(c.createdAt) },
              ],
            }}
            emptyNode={<EmptyState description="這個案件下沒有可顯示的合約" />}
          />
        </Card>
      )}

    </DetailPage>
  );
}
