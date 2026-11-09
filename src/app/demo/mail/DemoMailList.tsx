'use client';

// demo 寄件紀錄（MIL-120）：Mock 模式寄出的信。信不會離開伺服器，紀錄只存在伺服器記憶體。
import { useState } from 'react';
import { Alert, App as AntApp, Button, Flex, Table, Tag, Typography, type TableColumnsType } from 'antd';
import { useRouter } from 'next/navigation';

export interface DemoMailRow {
  id: string;
  sentAt: string;
  from: string | null;
  to: string;
  kind: string;
  subject: string;
  text: string;
}

const formatTime = (iso: string) =>
  new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'medium', hour12: false }).format(new Date(iso));

const columns: TableColumnsType<DemoMailRow> = [
  { title: '寄出時間', dataIndex: 'sentAt', key: 'sentAt', render: (v: string) => formatTime(v), width: 180 },
  {
    title: '寄件名義',
    dataIndex: 'from',
    key: 'from',
    render: (v: string | null) => v ?? <Typography.Text type="secondary">平台預設</Typography.Text>,
  },
  { title: '收件人', dataIndex: 'to', key: 'to' },
  { title: '種類', dataIndex: 'kind', key: 'kind', render: (v: string) => <Tag>{v}</Tag> },
  { title: '主旨', dataIndex: 'subject', key: 'subject' },
];

export default function DemoMailList({ rows }: { rows: DemoMailRow[] }) {
  const router = useRouter();
  const { message } = AntApp.useApp();
  const [sending, setSending] = useState(false);

  async function sendTest() {
    setSending(true);
    try {
      const res = await fetch('/api/demo/notify', { method: 'POST', body: JSON.stringify({}) });
      if (!res.ok) throw new Error(String(res.status));
      router.refresh();
    } catch {
      message.error('送出測試通知失敗。可能沒有登入，或目前的帳號不屬於任何組織。');
    } finally {
      setSending(false);
    }
  }

  return (
    <Flex vertical gap={16 /* md */} style={{ padding: 32 /* xl */ }}>
      <Flex justify="space-between" align="center" gap={12 /* sm */} wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          寄件紀錄
        </Typography.Title>
        <Button loading={sending} onClick={() => void sendTest()}>
          送出測試通知
        </Button>
      </Flex>
      <Alert
        type="info"
        showIcon
        title="Mock 模式：信不會真的寄出"
        description="紀錄只存在伺服器記憶體，服務重啟後清空。接上真實寄信服務後，這一頁不再提供。"
      />
      <Table<DemoMailRow>
        size="middle"
        rowKey="id"
        columns={columns}
        dataSource={rows}
        pagination={false}
        locale={{ emptyText: '還沒有寄出的信。按「送出測試通知」會寄一封。' }}
        expandable={{
          expandedRowRender: (row) => <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{row.text}</Typography.Paragraph>,
        }}
      />
    </Flex>
  );
}
