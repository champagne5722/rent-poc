'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, App as AntApp, Button, Empty, Flex, Form, Input, Popconfirm, Select, Table, Tag, Typography } from 'antd';

// 組織成員管理（MIL-106，ADR-0022 決議 5）。所有成員看得到成員列表，只有 admin 能邀請、改角色、移除。
// 按鈕是否顯示只是方便，權限在 /api/org/* 的 route 判斷（MIL-108 的 org_member.manage）。

type Role = 'admin' | 'staff' | 'viewer';

interface Member {
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  joinedAt: string;
}

interface Invitation {
  id: string;
  email: string;
  role: Role;
  invitedAt: string;
}

interface Payload {
  members: Member[];
  invitations: Invitation[];
  me: { userId: string; role: Role };
}

const ROLE_OPTIONS: Array<{ value: Role; label: string }> = [
  { value: 'admin', label: '管理員' },
  { value: 'staff', label: '業務人員' },
  { value: 'viewer', label: '唯讀' },
];
const ROLE_LABEL: Record<Role, string> = { admin: '管理員', staff: '業務人員', viewer: '唯讀' };

const formatDate = (iso: string) => new Date(iso).toLocaleDateString('zh-TW');

async function send(method: string, url: string, body?: unknown): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { ok: response.ok, status: response.status, body: ((await response.json().catch(() => ({}))) as Record<string, unknown>) ?? {} };
}

function MembersPanelInner() {
  const { message } = AntApp.useApp();
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm<{ email: string; role: Role }>();

  // load 只取資料不設狀態，effect 在 callback 內才設狀態（避免 effect 內同步 setState）
  const load = useCallback(async (): Promise<{ payload: Payload } | { error: string }> => {
    try {
      const response = await fetch('/api/org/members');
      if (response.status === 403) return { error: '目前的身分不是組織成員，沒有成員清單。' };
      if (!response.ok) throw new Error(String(response.status));
      return { payload: ((await response.json()) as { data: Payload }).data };
    } catch {
      return { error: '成員清單載入失敗，請重新整理。' };
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

  const reload = useCallback(async () => apply(await load()), [apply, load]);

  useEffect(() => {
    let cancelled = false;
    void load().then((result) => {
      if (!cancelled) apply(result);
    });
    return () => {
      cancelled = true;
    };
  }, [apply, load]);

  async function run(action: () => ReturnType<typeof send>, success: string, onDone?: () => void) {
    setBusy(true);
    try {
      const result = await action();
      if (result.ok) {
        message.success(success);
        onDone?.();
        await reload();
      } else {
        message.error(typeof result.body.error === 'string' ? result.body.error : '操作失敗，請稍後再試');
      }
    } catch {
      message.error('網路發生問題，請稍後再試');
    } finally {
      setBusy(false);
    }
  }

  if (error) return <Alert type="error" showIcon title={error} />;
  if (!data) return <Typography.Text type="secondary">載入中…</Typography.Text>;

  const isAdmin = data.me.role === 'admin';

  return (
    <Flex vertical gap="large" style={{ maxWidth: 960 }}>
      {isAdmin && (
        <Form
          form={form}
          layout="vertical"
          requiredMark={false}
          initialValues={{ role: 'staff' }}
          onFinish={(values) =>
            void run(
              () => send('POST', '/api/org/members', { email: values.email.trim(), role: values.role }),
              '已送出邀請。對方用這個 email 登入後就會加入。',
              () => form.resetFields(),
            )
          }
        >
          <Typography.Title level={5} style={{ marginTop: 0 }}>
            邀請成員
          </Typography.Title>
          <Flex gap="small" wrap align="flex-start">
            <Form.Item
              label="email"
              name="email"
              style={{ flex: '1 1 260px', marginBottom: 0 }}
              rules={[
                { required: true, message: '請輸入 email' },
                { type: 'email', message: '請輸入正確的 email' },
              ]}
            >
              <Input type="email" autoComplete="off" placeholder="name@example.com" />
            </Form.Item>
            <Form.Item label="角色" name="role" style={{ flex: '0 0 160px', marginBottom: 0 }}>
              <Select options={ROLE_OPTIONS} />
            </Form.Item>
            <Form.Item label=" " colon={false} style={{ marginBottom: 0 }}>
              <Button type="primary" htmlType="submit" loading={busy}>
                送出邀請
              </Button>
            </Form.Item>
          </Flex>
        </Form>
      )}

      <Flex vertical gap="small">
        <Typography.Title level={5} style={{ margin: 0 }}>
          成員
        </Typography.Title>
        <Table<Member>
          size="middle"
          rowKey="userId"
          pagination={false}
          dataSource={data.members}
          scroll={{ x: 'max-content' }}
          columns={[
            {
              title: '成員',
              dataIndex: 'displayName',
              render: (_value, member) => (
                <Flex vertical>
                  <Flex align="center" gap="small">
                    <Typography.Text>{member.displayName}</Typography.Text>
                    {member.userId === data.me.userId && <Tag>你</Tag>}
                  </Flex>
                  <Typography.Text type="secondary">{member.email}</Typography.Text>
                </Flex>
              ),
            },
            {
              title: '角色',
              dataIndex: 'role',
              width: 180,
              render: (role: Role, member) =>
                isAdmin ? (
                  <Select<Role>
                    value={role}
                    options={ROLE_OPTIONS}
                    style={{ width: 140 }}
                    disabled={busy}
                    aria-label={`${member.displayName} 的角色`}
                    onChange={(next) => void run(() => send('PATCH', `/api/org/members/${member.userId}`, { role: next }), '已更新角色')}
                  />
                ) : (
                  <Tag>{ROLE_LABEL[role]}</Tag>
                ),
            },
            { title: '加入日', dataIndex: 'joinedAt', width: 120, render: formatDate },
            ...(isAdmin
              ? [
                  {
                    title: '操作',
                    key: 'actions',
                    width: 100,
                    render: (_value: unknown, member: Member) => (
                      <Popconfirm
                        title={member.userId === data.me.userId ? '確定要離開這個組織？' : `確定要移除 ${member.displayName}？`}
                        description="移除後，對方下一個請求就會被拒絕。"
                        okText="移除"
                        okButtonProps={{ danger: true }}
                        cancelText="取消"
                        onConfirm={() =>
                          void run(
                            () => send('DELETE', `/api/org/members/${member.userId}`),
                            '已移除成員',
                            () => {
                              if (member.userId === data.me.userId) window.location.assign('/login');
                            },
                          )
                        }
                      >
                        <Button type="link" danger disabled={busy}>
                          移除
                        </Button>
                      </Popconfirm>
                    ),
                  },
                ]
              : []),
          ]}
        />
      </Flex>

      {isAdmin && (
        <Flex vertical gap="small">
          <Typography.Title level={5} style={{ margin: 0 }}>
            待處理的邀請
          </Typography.Title>
          <Table<Invitation>
            size="middle"
            rowKey="id"
            pagination={false}
            dataSource={data.invitations}
            scroll={{ x: 'max-content' }}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="沒有待處理的邀請" /> }}
            columns={[
              { title: 'email', dataIndex: 'email' },
              { title: '角色', dataIndex: 'role', width: 180, render: (role: Role) => <Tag>{ROLE_LABEL[role]}</Tag> },
              { title: '邀請日', dataIndex: 'invitedAt', width: 120, render: formatDate },
              {
                title: '操作',
                key: 'actions',
                width: 100,
                render: (_value: unknown, invitation: Invitation) => (
                  <Popconfirm
                    title="撤銷這個邀請？"
                    okText="撤銷"
                    okButtonProps={{ danger: true }}
                    cancelText="取消"
                    onConfirm={() => void run(() => send('DELETE', `/api/org/invitations/${invitation.id}`), '已撤銷邀請')}
                  >
                    <Button type="link" danger disabled={busy}>
                      撤銷
                    </Button>
                  </Popconfirm>
                ),
              },
            ]}
          />
        </Flex>
      )}
    </Flex>
  );
}

// 沿用 properties 頁的做法：頁面自己包 AntApp，message 才吃得到主題
export default function MembersPanel() {
  return (
    <AntApp>
      <MembersPanelInner />
    </AntApp>
  );
}
