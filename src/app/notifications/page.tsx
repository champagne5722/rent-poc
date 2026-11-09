'use client';

// 通知清單（MIL-120）：站內通知，新的在前。未讀的標題加粗並帶圓點，可逐則標已讀或全部標已讀。
import { useEffect, useState } from 'react';
import { App as AntApp, Badge, Button, Empty, Flex, Result, Skeleton, Table, Typography } from 'antd';
import Link from 'next/link';
import { NOTIFICATIONS_CHANGED_EVENT } from '@/lib/notifications/client-events';
import type { NotificationDto } from '@/lib/notifications/member-route';

type LoadState = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; items: NotificationDto[]; unread: number };

const formatTime = (iso: string) =>
  new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short', hour12: false }).format(new Date(iso));

async function fetchState(): Promise<LoadState> {
  try {
    const res = await fetch('/api/notifications');
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as { data: { items: NotificationDto[]; unread: number } };
    return { kind: 'ready', ...body.data };
  } catch {
    return { kind: 'error' };
  }
}

export default function NotificationsPage() {
  const { message } = AntApp.useApp();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchState().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function post(url: string, failure: string) {
    setBusy(true);
    try {
      const res = await fetch(url, { method: 'POST' });
      if (!res.ok) throw new Error(String(res.status));
      setState(await fetchState());
      window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT));
    } catch {
      message.error(failure);
    } finally {
      setBusy(false);
    }
  }

  if (state.kind === 'loading') return <Skeleton active paragraph={{ rows: 4 }} />;
  if (state.kind === 'error') {
    return (
      <Result
        status="warning"
        title="讀不到通知"
        subTitle="可能是連線問題，或目前的帳號不屬於任何組織。"
        extra={<Button onClick={() => void fetchState().then(setState)}>重新讀取</Button>}
      />
    );
  }

  const { items, unread } = state;
  return (
    <Flex vertical gap={16 /* md */} style={{ maxWidth: 800 }}>
      <Flex justify="space-between" align="center" gap={12 /* sm */} wrap>
        <Flex vertical>
          <Typography.Title level={4} style={{ margin: 0 }}>
            通知
          </Typography.Title>
          <Typography.Text type="secondary">{unread > 0 ? `${unread} 則未讀` : '沒有未讀通知'}</Typography.Text>
        </Flex>
        <Button disabled={unread === 0 || busy} onClick={() => void post('/api/notifications/read-all', '全部標為已讀失敗，請再試一次')}>
          全部標為已讀
        </Button>
      </Flex>

      <Table<NotificationDto>
        size="middle"
        rowKey="id"
        showHeader={false}
        pagination={false}
        dataSource={items}
        locale={{ emptyText: <Empty description="目前沒有通知" /> }}
        columns={[
          {
            key: 'content',
            render: (_, item) => (
              <Flex vertical gap={4 /* xxs */}>
                <Flex gap={8 /* xs */} align="center">
                  {!item.read && <Badge status="processing" aria-label="未讀" />}
                  {item.linkPath ? (
                    <Link href={item.linkPath} style={item.read ? undefined : { fontWeight: 600 }}>
                      {item.title}
                    </Link>
                  ) : (
                    <Typography.Text strong={!item.read}>{item.title}</Typography.Text>
                  )}
                </Flex>
                <Typography.Text>{item.body}</Typography.Text>
                <Typography.Text type="secondary">{formatTime(item.createdAt)}</Typography.Text>
              </Flex>
            ),
          },
          {
            key: 'action',
            align: 'right',
            width: 120,
            render: (_, item) =>
              item.read ? (
                <Typography.Text type="secondary">已讀</Typography.Text>
              ) : (
                <Button
                  type="link"
                  size="small"
                  disabled={busy}
                  onClick={() => void post(`/api/notifications/${item.id}/read`, '標為已讀失敗，請再試一次')}
                >
                  標為已讀
                </Button>
              ),
          },
        ]}
      />
    </Flex>
  );
}
