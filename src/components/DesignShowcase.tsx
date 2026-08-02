'use client';

// 設計樣式頁的畫面：左欄是 DESIGN.md 的原始 token（色彩、字級、間距、圓角），
// 右欄是套用後的 antd 元件實品，調 DESIGN.md 時開這頁對照。
import {
  Alert,
  Button,
  Card,
  Flex,
  Input,
  Select,
  Table,
  Tag,
  Typography,
  theme,
} from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import type { DesignFrontMatter } from '@/lib/design-theme';

const { Title, Text, Paragraph } = Typography;

function Swatch({ name, value }: { name: string; value: string }) {
  const { token } = theme.useToken();
  return (
    <Flex align="center" gap={8} style={{ width: 220 }}>
      <span
        style={{
          width: 28,
          height: 28,
          borderRadius: token.borderRadiusSM,
          background: value,
          border: `1px solid ${token.colorBorder}`,
          flex: 'none',
        }}
      />
      <Text style={{ fontSize: 13 }}>{name}</Text>
      <Text type="secondary" style={{ fontSize: 12, marginLeft: 'auto' }}>
        {value}
      </Text>
    </Flex>
  );
}

const SAMPLE_ROWS = [
  { id: 7, property: '南京復興整層住家', rent: 42000, status: '待甲方簽', color: 'processing' },
  { id: 6, property: '信義安和小套房', rent: 18000, status: '已完成', color: 'success' },
  { id: 2, property: '大安區溫馨兩房', rent: 28000, status: '已拒簽', color: 'error' },
];

export default function DesignShowcase({ data }: { data: DesignFrontMatter | null }) {
  const { token } = theme.useToken();

  if (!data) {
    return <Alert type="error" title="DESIGN.md 讀取失敗" description="請確認 repo 根目錄的 DESIGN.md 存在且含 front matter。" />;
  }

  const headingSizes = [
    { level: 1 as const, px: token.fontSizeHeading1 },
    { level: 2 as const, px: token.fontSizeHeading2 },
    { level: 3 as const, px: token.fontSizeHeading3 },
    { level: 4 as const, px: token.fontSizeHeading4 },
    { level: 5 as const, px: token.fontSizeHeading5 },
  ];

  return (
    <Flex vertical gap={24} style={{ maxWidth: 960 }}>
      <div>
        <Title level={4} style={{ marginTop: 0 }}>
          設計樣式
        </Title>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {data.name}：以下全部由 DESIGN.md 驅動，改 token 存檔即更新。字級與元件樣式是 antd
          依 seed token 派生的實際結果。
        </Paragraph>
      </div>

      <Card title="字體階層（antd 派生結果）">
        <Flex vertical gap={4}>
          {headingSizes.map(({ level, px }) => (
            <Flex key={level} align="baseline" gap={16}>
              <Title level={level} style={{ margin: 0 }}>
                標題 H{level}
              </Title>
              <Text type="secondary">{px}px</Text>
            </Flex>
          ))}
          <Flex align="baseline" gap={16} style={{ marginTop: 8 }}>
            <Text>內文 body</Text>
            <Text type="secondary">{token.fontSize}px／行高 {token.lineHeight.toFixed(2)}</Text>
          </Flex>
          <Text type="secondary">次要說明 ink-muted</Text>
          <Text type="secondary" style={{ color: token.colorTextTertiary }}>
            佔位與停用 ink-subtle
          </Text>
        </Flex>
      </Card>

      <Card title="色彩 token（DESIGN.md 原始值）">
        <Flex wrap gap={12}>
          {Object.entries(data.colors ?? {}).map(([name, value]) => (
            <Swatch key={name} name={name} value={value} />
          ))}
        </Flex>
      </Card>

      <Card title="間距 scale（版面 gap 引用這些值）">
        <Flex vertical gap={8}>
          {Object.entries(data.spacing ?? {}).map(([name, value]) => (
            <Flex key={name} align="center" gap={16}>
              <Text style={{ width: 48 }}>{name}</Text>
              <span
                style={{
                  height: 12,
                  width: parseFloat(value),
                  background: token.colorPrimary,
                  borderRadius: 2,
                }}
              />
              <Text type="secondary">{value}</Text>
            </Flex>
          ))}
        </Flex>
      </Card>

      <Card title="元件樣品">
        <Flex vertical gap={16}>
          <Flex wrap gap={12} align="center">
            <Button type="primary" icon={<PlusOutlined />}>
              主要動作
            </Button>
            <Button>次要動作</Button>
            <Button type="dashed">虛線</Button>
            <Button danger icon={<DeleteOutlined />}>
              危險動作
            </Button>
            <Button type="primary" disabled>
              停用
            </Button>
          </Flex>
          <Flex wrap gap={8}>
            <Tag color="processing">簽署中</Tag>
            <Tag color="success">已完成</Tag>
            <Tag color="error">已拒簽</Tag>
            <Tag color="warning">已撤回</Tag>
            <Tag>草稿</Tag>
          </Flex>
          <Flex wrap gap={12}>
            <Input placeholder="輸入框" style={{ width: 200 }} />
            <Select
              placeholder="下拉選單"
              style={{ width: 200 }}
              options={[
                { value: 'a', label: '選項一' },
                { value: 'b', label: '選項二' },
              ]}
            />
          </Flex>
          <Table
            size="middle"
            rowKey="id"
            pagination={false}
            dataSource={SAMPLE_ROWS}
            columns={[
              { title: '#', dataIndex: 'id', width: 56 },
              { title: '物件', dataIndex: 'property' },
              {
                title: '租金',
                dataIndex: 'rent',
                align: 'right',
                render: (rent: number) => `$${rent.toLocaleString()}`,
              },
              {
                title: '狀態',
                dataIndex: 'status',
                render: (_: string, row) => <Tag color={row.color}>{row.status}</Tag>,
              },
            ]}
          />
        </Flex>
      </Card>
    </Flex>
  );
}
