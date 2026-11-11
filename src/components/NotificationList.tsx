'use client';

// 通知清單（MIL-120、MIL-179）：套用列表頁版型。資料由 server component 載入後傳進來。
// 未讀的列有圓點、粗體標題與「未讀」字樣，已讀的列用次要文字色。
// 標已讀成功後呼叫 router.refresh()，並通知殼層重讀未讀數。
import { useMemo, useState, useTransition } from 'react';
import { App as AntApp, Badge, Button, Flex, Typography } from 'antd';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import ListPage from '@/components/page/ListPage';
import { NOTIFICATIONS_CHANGED_EVENT } from '@/lib/notifications/client-events';
import type { NotificationDto } from '@/lib/notifications/member-route';
import { formatTaipeiDateTime } from '@/lib/ownership/format';

type ReadFilter = 'all' | 'unread';

// 固定用台灣時間。不用 dateStyle：Node 與 Chromium 的 ICU 在日期與時間之間用不同的空白字元，會造成 hydration 錯誤（MIL-185）
const formatTime = formatTaipeiDateTime;

export interface NotificationListProps {
  items: NotificationDto[];
}

function NotificationListInner({ items }: NotificationListProps) {
  const { message } = AntApp.useApp();
  const router = useRouter();
  const [, startRefresh] = useTransition();
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<ReadFilter>('all');

  const unread = useMemo(() => items.filter((n) => !n.read).length, [items]);
  const rows = useMemo(() => (filter === 'unread' ? items.filter((n) => !n.read) : items), [items, filter]);

  async function post(url: string, failure: string) {
    setBusy(true);
    try {
      const res = await fetch(url, { method: 'POST' });
      if (!res.ok) throw new Error(String(res.status));
      window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT));
      startRefresh(() => router.refresh());
    } catch {
      message.error(failure);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ListPage<NotificationDto, ReadFilter>
      header={{
        title: '通知列表',
        extra: (
          <Button disabled={unread === 0 || busy} onClick={() => void post('/api/notifications/read-all', '全部標為已讀失敗，請再試一次')}>
            全部標為已讀
          </Button>
        ),
      }}
      filter={{
        status: {
          value: filter,
          onChange: setFilter,
          options: [
            { value: 'all', label: '全部', count: items.length },
            { value: 'unread', label: '未讀', count: unread },
          ],
        },
        active: filter !== 'all',
        onClear: () => setFilter('all'),
      }}
      empty={{ description: '目前沒有通知。合約、簽署與移交有新進度時，會顯示在這裡。' }}
      table={{
        rowKey: 'id',
        dataSource: rows,
        columns: [
          {
            title: '通知',
            key: 'content',
            render: (_, item) => (
              <Flex vertical gap="small">
                <Flex gap="small" align="center">
                  {!item.read && <Badge status="processing" aria-label="未讀" />}
                  {item.linkPath ? (
                    <Link href={item.linkPath}>
                      <Typography.Text strong={!item.read}>{item.title}</Typography.Text>
                    </Link>
                  ) : (
                    <Typography.Text strong={!item.read}>{item.title}</Typography.Text>
                  )}
                </Flex>
                <Typography.Text type={item.read ? 'secondary' : undefined}>{item.body}</Typography.Text>
              </Flex>
            ),
          },
          {
            title: '時間',
            key: 'time',
            width: 168,
            render: (_, item) => <Typography.Text type="secondary">{formatTime(item.createdAt)}</Typography.Text>,
          },
          {
            title: '狀態',
            key: 'state',
            width: 72,
            render: (_, item) =>
              item.read ? <Typography.Text type="secondary">已讀</Typography.Text> : <Typography.Text strong>未讀</Typography.Text>,
          },
          {
            title: '操作',
            key: 'action',
            width: 96,
            fixed: 'right',
            render: (_, item) =>
              item.read ? null : (
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
        ],
      }}
    />
  );
}

export default function NotificationList(props: NotificationListProps) {
  return (
    <AntApp>
      <NotificationListInner {...props} />
    </AntApp>
  );
}
