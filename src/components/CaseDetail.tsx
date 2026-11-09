'use client';

import { useCallback, useEffect, useState } from 'react';
import { App as AntApp, Alert, Button, Col, Descriptions, Flex, Form, Input, Modal, Row, Spin, Table, Tabs, Tag, Typography, theme } from 'antd';
import Link from 'next/link';
import type { CaseContractRow, CaseEventRecord, CaseMemberRecord, CaseRecord } from '@/lib/case-store';
import { isTenantRelation } from '@/lib/cases';
import { eventDescription, formatTaipei, leasePeriodLabel, monthlyRentLabel } from '@/lib/case-display';
import { BUSINESS_TYPE_LABELS } from '@/lib/labels';
import { CASE_MEMBER_RELATION_LABELS, CASE_STATE_COLORS, CASE_STATE_LABELS } from '@/lib/labels/case-labels';
import { shortUlid } from '@/lib/pg/ulid';
import { CONTRACT_STATUS_LABELS, type ContractStatus } from '@/lib/types';

// 案件詳情（MIL-115）：概況、成員、合約、案件事件，分頁呈現（DESIGN.md「Layout」）。
// readOnly 是案件成員的唯讀版本，屋主從資產總覽進入（MIL-94）。主辦組織的管理員與業務人員另有加入共同承租人。

interface Detail {
  case: CaseRecord;
  orgName: string | null;
  isHost: boolean;
  members: CaseMemberRecord[];
  contracts: CaseContractRow[];
  events: CaseEventRecord[];
  canManageMembers: boolean;
}

type Load = { status: 'loading' } | { status: 'missing' } | { status: 'ready'; detail: Detail };

export default function CaseDetail({ caseId, readOnly = false, backHref }: { caseId: string; readOnly?: boolean; backHref: string }) {
  return (
    <AntApp>
      <CaseDetailBody caseId={caseId} readOnly={readOnly} backHref={backHref} />
    </AntApp>
  );
}

function CaseDetailBody({ caseId, readOnly, backHref }: { caseId: string; readOnly: boolean; backHref: string }) {
  const { message } = AntApp.useApp();
  const { token } = theme.useToken();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [adding, setAdding] = useState(false);
  const [form] = Form.useForm<{ name: string; email: string }>();
  // 更新承租人 email（MIL-121）：正在更新哪一位成員。null 表示 Modal 關閉
  const [replacing, setReplacing] = useState<CaseMemberRecord | null>(null);
  const [replacingBusy, setReplacingBusy] = useState(false);
  const [replaceForm] = Form.useForm<{ email: string }>();

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/cases/${caseId}`);
    if (!res.ok) return setLoad({ status: 'missing' });
    setLoad({ status: 'ready', detail: (await res.json()).data });
  }, [caseId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 載入資料後設定狀態是這個元件的用途
    void refresh();
  }, [refresh]);

  if (load.status === 'loading') {
    return (
      <Flex justify="center" style={{ padding: token.paddingXL }}>
        <Spin />
      </Flex>
    );
  }
  if (load.status === 'missing') {
    return (
      <Alert
        type="info"
        showIcon
        message="找不到這個案件"
        description="案件不存在，或你不是這個案件的成員。"
        action={
          <Link href={backHref}>
            <Button size="small">回上一頁</Button>
          </Link>
        }
      />
    );
  }

  const { detail } = load;
  const { case: record } = detail;
  const canEdit = !readOnly && detail.isHost && detail.canManageMembers;

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
      await refresh();
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
      await refresh();
    } finally {
      setReplacingBusy(false);
    }
  };

  return (
    <Flex vertical gap="large">
      <Flex align="center" gap="small" wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {record.title || '（未命名案件）'}
        </Typography.Title>
        <Tag color={CASE_STATE_COLORS[record.state]}>{CASE_STATE_LABELS[record.state]}</Tag>
        {readOnly && <Tag>唯讀</Tag>}
        <Link href={backHref}>返回</Link>
      </Flex>

      <Tabs
        items={[
          {
            key: 'overview',
            label: '概況',
            children: (
              <Descriptions
                column={1}
                size="small"
                bordered
                items={[
                  { key: 'type', label: '業務類型', children: record.businessType ? BUSINESS_TYPE_LABELS[record.businessType] : '委託管理' },
                  { key: 'state', label: '狀態', children: CASE_STATE_LABELS[record.state] },
                  { key: 'period', label: '租期', children: leasePeriodLabel(record.leaseStart, record.leaseEnd) },
                  { key: 'rent', label: '月租金', children: monthlyRentLabel(record.monthlyRent) },
                  { key: 'org', label: '主辦', children: detail.isHost ? '本組織' : (detail.orgName ?? '—') },
                  { key: 'created', label: '建立時間', children: formatTaipei(record.createdAt) },
                ]}
              />
            ),
          },
          {
            key: 'members',
            label: `成員 ${detail.members.filter((m) => m.validUntil === null).length}`,
            children: (
              <Flex vertical gap="large">
                <Table<CaseMemberRecord>
                  rowKey="id"
                  size="middle"
                  dataSource={detail.members}
                  pagination={false}
                  scroll={{ x: 'max-content' }}
                  locale={{ emptyText: '沒有可顯示的成員' }}
                  columns={[
                    { title: '關係', width: 120, render: (_, m) => CASE_MEMBER_RELATION_LABELS[m.relation] },
                    { title: '姓名', dataIndex: 'displayName' },
                    { title: 'Email', dataIndex: 'email' },
                    { title: '加入時間', width: 160, render: (_, m) => formatTaipei(m.validFrom) },
                    { title: '狀態', width: 90, render: (_, m) => (m.validUntil === null ? '有效' : '已結束') },
                    ...(canEdit
                      ? [
                          {
                            title: '操作',
                            width: 120,
                            render: (_: unknown, m: CaseMemberRecord) =>
                              m.validUntil === null && isTenantRelation(m.relation) ? (
                                <Button type="link" size="small" onClick={() => setReplacing(m)}>
                                  更新 email
                                </Button>
                              ) : null,
                          },
                        ]
                      : []),
                  ]}
                />
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
                      <Form.Item
                        name="email"
                        label="新的 email"
                        rules={[{ required: true, type: 'email', message: '請填寫有效的 email' }]}
                      >
                        <Input autoComplete="off" />
                      </Form.Item>
                    </Form>
                  </Flex>
                </Modal>
                {canEdit && (
                  <Row>
                    <Col xs={24} md={12} lg={8}>
                      <Form form={form} layout="vertical" onFinish={(values) => void addMember(values)}>
                    <Typography.Text strong>加入共同承租人</Typography.Text>
                    <Form.Item name="name" label="姓名" rules={[{ required: true, message: '請填寫姓名' }]}>
                      <Input />
                    </Form.Item>
                    <Form.Item
                      name="email"
                      label="Email"
                      rules={[{ required: true, type: 'email', message: '請填寫有效的 email' }]}
                    >
                      <Input />
                    </Form.Item>
                    <Button type="primary" htmlType="submit" loading={adding}>
                      加入
                    </Button>
                      </Form>
                    </Col>
                  </Row>
                )}
              </Flex>
            ),
          },
          {
            key: 'contracts',
            label: `合約 ${detail.contracts.length}`,
            children: (
              <Table<CaseContractRow>
                rowKey="id"
                size="middle"
                dataSource={detail.contracts}
                pagination={false}
                scroll={{ x: 'max-content' }}
                locale={{ emptyText: '這個案件下沒有可顯示的合約' }}
                columns={[
                  {
                    title: 'ID 末碼',
                    width: 110,
                    render: (_, c) =>
                      detail.isHost ? <Link href={`/contracts/${c.id}`}>{shortUlid(c.id)}</Link> : shortUlid(c.id),
                  },
                  { title: '狀態', width: 110, render: (_, c) => CONTRACT_STATUS_LABELS[c.status as ContractStatus] },
                  { title: '目前合約', width: 100, render: (_, c) => (c.isCurrent ? <Tag color="processing">目前</Tag> : '—') },
                  {
                    title: '衍生自',
                    width: 110,
                    render: (_, c) => (c.derivedFrom ? shortUlid(c.derivedFrom) : '—'),
                  },
                  { title: '建立時間', width: 160, render: (_, c) => formatTaipei(c.createdAt) },
                ]}
              />
            ),
          },
          {
            key: 'events',
            label: `案件事件 ${detail.events.length}`,
            children: (
              <Table<CaseEventRecord>
                rowKey="id"
                size="middle"
                dataSource={detail.events}
                pagination={false}
                scroll={{ x: 'max-content' }}
                locale={{ emptyText: '沒有可顯示的案件事件' }}
                columns={[
                  { title: '時間', width: 160, render: (_, e) => formatTaipei(e.occurredAt) },
                  { title: '事件', render: (_, e) => eventDescription(e) },
                ]}
              />
            ),
          },
        ]}
      />
    </Flex>
  );
}
