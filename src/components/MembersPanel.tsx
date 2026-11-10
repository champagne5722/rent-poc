'use client';

import { useState, useTransition } from 'react';
import { App as AntApp, Button, Flex, Form, Input, Popconfirm, Select, Tag, Typography } from 'antd';
import { useRouter } from 'next/navigation';
import EmptyState from '@/components/page/EmptyState';
import ListTable from '@/components/page/ListTable';
import SettingsPage from '@/components/page/SettingsPage';
import SettingsSection from '@/components/page/SettingsSection';
import type { InvitationRow, MemberRow } from '@/lib/orgs/members';
import type { OrgRole } from '@/lib/request-context';
import styles from './MembersPanel.module.css';

// 組織成員管理（MIL-106、MIL-181，ADR-0022 決議 5）。所有成員看得到成員列表，只有 admin 能邀請、改角色、移除。
// 按鈕是否顯示只是方便，權限在 /api/org/* 的 route 判斷（MIL-108 的 org_member.manage）。
// 資料由 server component 載入後傳進來。操作成功後呼叫 router.refresh() 重新載入。

const ROLE_OPTIONS: Array<{ value: OrgRole; label: string }> = [
  { value: 'admin', label: '管理員' },
  { value: 'staff', label: '業務人員' },
  { value: 'viewer', label: '唯讀' },
];
const ROLE_LABEL: Record<OrgRole, string> = { admin: '管理員', staff: '業務人員', viewer: '唯讀' };

// 固定用台灣時間，讓 server 與瀏覽器渲染的文字一致
const dateFormat = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei' });
const formatDate = (iso: string) => dateFormat.format(new Date(iso));

async function send(method: string, url: string, body?: unknown): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { ok: response.ok, status: response.status, body: ((await response.json().catch(() => ({}))) as Record<string, unknown>) ?? {} };
}

export interface MembersPanelProps {
  members: MemberRow[];
  invitations: InvitationRow[];
  me: { userId: string; role: OrgRole };
}

function MembersPanelInner({ members, invitations, me }: MembersPanelProps) {
  const { message } = AntApp.useApp();
  const router = useRouter();
  const [, startRefresh] = useTransition();
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm<{ email: string; role: OrgRole }>();
  const isAdmin = me.role === 'admin';

  async function run(action: () => ReturnType<typeof send>, success: string, onDone?: () => void) {
    setBusy(true);
    try {
      const result = await action();
      if (result.ok) {
        message.success(success);
        onDone?.();
        startRefresh(() => router.refresh());
      } else {
        message.error(typeof result.body.error === 'string' ? result.body.error : '操作失敗，請稍後再試');
      }
    } catch {
      message.error('網路發生問題，請稍後再試');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsPage header={{ title: '成員管理' }}>
      {isAdmin && (
        <SettingsSection title="邀請成員" description="對方用這個 email 登入後，就會加入這個組織。">
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
            <Flex gap="small" wrap align="flex-start">
              <Form.Item
                label="email"
                name="email"
                className={styles.emailField}
                rules={[
                  { required: true, message: '請輸入 email' },
                  { type: 'email', message: '請輸入正確的 email' },
                ]}
              >
                <Input type="email" autoComplete="off" placeholder="name@example.com" />
              </Form.Item>
              <Form.Item label="角色" name="role" className={styles.roleField}>
                <Select options={ROLE_OPTIONS} />
              </Form.Item>
              <Form.Item label=" " colon={false} className={styles.submitField}>
                <Button type="primary" htmlType="submit" loading={busy}>
                  送出邀請
                </Button>
              </Form.Item>
            </Flex>
          </Form>
        </SettingsSection>
      )}

      <SettingsSection title="成員">
        <ListTable<MemberRow>
          emptyNode={<EmptyState description="這個組織還沒有成員。" />}
          table={{
            rowKey: 'userId',
            dataSource: members,
            scroll: { x: 'max-content' },
            columns: [
              {
                title: '成員',
                dataIndex: 'displayName',
                render: (_value, member) => (
                  <Flex vertical>
                    <Flex align="center" gap="small">
                      <Typography.Text>{member.displayName}</Typography.Text>
                      {member.userId === me.userId && <Tag>你</Tag>}
                    </Flex>
                    <Typography.Text type="secondary">{member.email}</Typography.Text>
                  </Flex>
                ),
              },
              {
                title: '角色',
                dataIndex: 'role',
                width: 180,
                render: (role: OrgRole, member) =>
                  isAdmin ? (
                    <Select<OrgRole>
                      value={role}
                      options={ROLE_OPTIONS}
                      className={styles.roleSelect}
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
                      fixed: 'right' as const,
                      render: (_value: unknown, member: MemberRow) => (
                        <Popconfirm
                          title={member.userId === me.userId ? '確定要離開這個組織？' : `確定要移除 ${member.displayName}？`}
                          description="移除後，對方下一個請求就會被拒絕。"
                          okText="移除"
                          okButtonProps={{ danger: true }}
                          cancelText="取消"
                          onConfirm={() =>
                            void run(
                              () => send('DELETE', `/api/org/members/${member.userId}`),
                              '已移除成員',
                              () => {
                                if (member.userId === me.userId) window.location.assign('/login');
                              },
                            )
                          }
                        >
                          <Button type="link" size="small" danger disabled={busy}>
                            移除
                          </Button>
                        </Popconfirm>
                      ),
                    },
                  ]
                : []),
            ],
          }}
        />
      </SettingsSection>

      {isAdmin && (
        <SettingsSection title="待處理的邀請">
          <ListTable<InvitationRow>
            emptyNode={<EmptyState description="沒有待處理的邀請。要邀請成員，請用上方的「邀請成員」。" />}
            table={{
              rowKey: 'id',
              dataSource: invitations,
              scroll: { x: 'max-content' },
              columns: [
                { title: 'email', dataIndex: 'email' },
                { title: '角色', dataIndex: 'role', width: 180, render: (role: OrgRole) => <Tag>{ROLE_LABEL[role]}</Tag> },
                { title: '邀請日', dataIndex: 'invitedAt', width: 120, render: formatDate },
                {
                  title: '操作',
                  key: 'actions',
                  width: 100,
                  fixed: 'right',
                  render: (_value: unknown, invitation: InvitationRow) => (
                    <Popconfirm
                      title="撤銷這個邀請？"
                      okText="撤銷"
                      okButtonProps={{ danger: true }}
                      cancelText="取消"
                      onConfirm={() => void run(() => send('DELETE', `/api/org/invitations/${invitation.id}`), '已撤銷邀請')}
                    >
                      <Button type="link" size="small" danger disabled={busy}>
                        撤銷
                      </Button>
                    </Popconfirm>
                  ),
                },
              ],
            }}
          />
        </SettingsSection>
      )}
    </SettingsPage>
  );
}

// 頁面自己包 AntApp，message 才吃得到主題
export default function MembersPanel(props: MembersPanelProps) {
  return (
    <AntApp>
      <MembersPanelInner {...props} />
    </AntApp>
  );
}
