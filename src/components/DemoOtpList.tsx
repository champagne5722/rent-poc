'use client';

import { Alert, Button, Flex, Table, Typography, theme } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useRouter } from 'next/navigation';

export interface DemoMailRow {
  id: string;
  sentAt: string;
  to: string;
  kind: string;
  code: string | null;
}

// demo 的最近驗證碼清單（MIL-103）。只給 demo 與本機開發看，新的在前。
export default function DemoOtpList({ rows }: { rows: DemoMailRow[] }) {
  const router = useRouter();
  const { token } = theme.useToken();

  return (
    <div style={{ minHeight: '100vh', background: token.colorBgLayout }}>
    <Flex vertical gap="large" style={{ maxWidth: 800, margin: '0 auto', padding: token.paddingLG }}>
      <Flex justify="space-between" align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          最近的驗證碼
        </Typography.Title>
        <Button icon={<ReloadOutlined />} onClick={() => router.refresh()}>
          重新整理
        </Button>
      </Flex>
      <Alert
        type="warning"
        showIcon
        message="這一頁只在寄信用 log adapter 時存在"
        description="只因 demo 只放測試資料才可接受。接上真實寄信服務後這一頁會消失。伺服器重啟後清單會清空。"
      />
      <Table<DemoMailRow>
        size="middle"
        rowKey="id"
        pagination={false}
        dataSource={rows}
        locale={{ emptyText: '還沒有寄出任何信' }}
        columns={[
          { title: '時間', dataIndex: 'sentAt', render: (v: string) => dayjs(v).format('MM-DD HH:mm:ss') },
          { title: '收件人', dataIndex: 'to' },
          { title: '種類', dataIndex: 'kind' },
          {
            title: '驗證碼',
            dataIndex: 'code',
            align: 'right',
            render: (v: string | null) => (v ? <Typography.Text strong style={{ fontVariantNumeric: 'tabular-nums' }}>{v}</Typography.Text> : '—'),
          },
        ]}
      />
    </Flex>
    </div>
  );
}
