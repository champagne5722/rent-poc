'use client';

// 設計樣式頁的畫面：上半是 DESIGN.md 的原始 token（字階、色彩、間距、圓角），
// 下半是套用元件層 token 後的 antd 元件實品，調 DESIGN.md 時開這頁對照。
// 字階用 design-system.css 的 type-* class，不手寫 font-size。
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Flex,
  Form,
  Input,
  Layout,
  Menu,
  Select,
  Steps,
  Table,
  Tag,
  Typography,
  theme,
} from 'antd';
import { DeleteOutlined, FileTextOutlined, HomeOutlined, PlusOutlined } from '@ant-design/icons';
import type { DesignFrontMatter } from '@/lib/design-theme';
import styles from './DesignShowcase.module.css';

const { Text } = Typography;

const TYPE_LEVELS = [
  { key: 'page-title', label: '頁面標題', sample: '合約列表', usage: '每頁的標題，一頁一個' },
  { key: 'section-title', label: '區段標題', sample: '簽署進度', usage: 'Card 標題與頁面內的區段' },
  { key: 'body', label: '內文', sample: '南京復興整層住家，租期 12 個月，每月租金 42,000 元。', usage: '表格、表單與一般文字' },
  { key: 'caption', label: '輔助文字', sample: '最後更新於 2026-11-10 10:00', usage: '說明、時間戳與欄位提示' },
] as const;

const SAMPLE_ROWS = [
  { id: 7, property: '南京復興整層住家', rent: 42000, status: '待甲方簽', color: 'processing' },
  { id: 6, property: '信義安和小套房', rent: 18000, status: '已完成', color: 'success' },
  { id: 2, property: '大安區溫馨兩房', rent: 28000, status: '已拒簽', color: 'error' },
  { id: 1, property: '中山北路兩房', rent: 26000, status: '草稿', color: 'default' },
];

function Swatch({ name, value }: { name: string; value: string }) {
  const { token } = theme.useToken();
  return (
    <Flex align="center" gap={token.marginXS} className={styles.swatchRow}>
      <svg className={styles.swatch} viewBox="0 0 28 28" aria-hidden>
        <rect x="0.5" y="0.5" width="27" height="27" rx={token.borderRadiusSM} fill={value} stroke={token.colorBorder} />
      </svg>
      <Text>{name}</Text>
      <Text type="secondary" className="type-caption">
        {value}
      </Text>
    </Flex>
  );
}

function Sample({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card title={title}>
      {children}
    </Card>
  );
}

export default function DesignShowcase({ data }: { data: DesignFrontMatter | null }) {
  const { token } = theme.useToken();

  if (!data) {
    return (
      <Alert
        type="error"
        title="DESIGN.md 讀取失敗"
        description="請確認 repo 根目錄的 DESIGN.md 存在且含 front matter。"
      />
    );
  }

  return (
    <Flex vertical gap={token.marginLG} className={styles.showcase}>
      <div>
        <h1 className="type-page-title">設計樣式</h1>
        <p className="type-caption">
          {data.name}：以下全部由 DESIGN.md 驅動，改 token 存檔即更新。字階來自 typography，元件外觀來自
          components。
        </p>
      </div>

      <Sample title="字階（typography）">
        <Flex vertical gap={token.marginMD}>
          {TYPE_LEVELS.map(({ key, label, sample, usage }) => {
            const spec = data.typography?.[key];
            return (
              <Flex key={key} align="baseline" gap={token.marginMD}>
                <Text type="secondary" className={`type-caption ${styles.typeLabel}`}>
                  {label}
                  <br />
                  {spec?.fontSize}／{spec?.fontWeight}／{spec?.lineHeight}
                </Text>
                <div>
                  <div className={`type-${key}`}>{sample}</div>
                  <Text type="secondary" className="type-caption">
                    {usage}
                  </Text>
                </div>
              </Flex>
            );
          })}
        </Flex>
      </Sample>

      <Sample title="色彩（colors）">
        <Flex wrap gap={token.marginSM}>
          {Object.entries(data.colors ?? {}).map(([name, value]) => (
            <Swatch key={name} name={name} value={value} />
          ))}
        </Flex>
      </Sample>

      <Sample title="間距與圓角（spacing、rounded）">
        <Flex vertical gap={token.marginXS}>
          {Object.entries(data.spacing ?? {}).map(([name, value]) => (
            <Flex key={name} align="center" gap={token.marginMD}>
              <Text className={styles.scaleName}>{name}</Text>
              <svg className={styles.spacingBar} width={parseFloat(value)} height="12" aria-hidden>
                <rect width={parseFloat(value)} height="12" rx={token.borderRadiusXS} fill={token.colorPrimary} />
              </svg>
              <Text type="secondary" className="type-caption">
                {value}
              </Text>
            </Flex>
          ))}
          <Flex gap={token.marginMD} className={styles.radiusRow}>
            {Object.entries(data.rounded ?? {}).map(([name, value]) => (
              <Flex key={name} vertical align="center" gap={token.marginXXS}>
                <svg className={styles.radiusBox} viewBox="0 0 56 40" aria-hidden>
                  <rect
                    x="0.5"
                    y="0.5"
                    width="55"
                    height="39"
                    rx={parseFloat(value)}
                    fill="none"
                    stroke={token.colorBorder}
                  />
                </svg>
                <Text type="secondary" className="type-caption">
                  {name} {value}
                </Text>
              </Flex>
            ))}
          </Flex>
        </Flex>
      </Sample>

      <Sample title="Table、Tag（列高、標頭底色、列的 hover 與選取）">
        <Table
          size="middle"
          rowKey="id"
          pagination={false}
          dataSource={SAMPLE_ROWS}
          rowSelection={{ selectedRowKeys: [6], onChange: () => {} }}
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
              render: (_: string, row) => <Tag color={row.color === 'default' ? undefined : row.color}>{row.status}</Tag>,
            },
            { title: '操作', render: () => <a>檢視</a> },
          ]}
        />
        <div className={styles.sampleGap}>
          <Flex wrap gap={token.marginXS}>
            <Tag color="processing">簽署中</Tag>
            <Tag color="success">已完成</Tag>
            <Tag color="error">已拒簽</Tag>
            <Tag color="warning">已撤回</Tag>
            <Tag>草稿</Tag>
          </Flex>
        </div>
      </Sample>

      <Sample title="Button">
        <Flex wrap gap={token.marginSM} align="center">
          <Button type="primary" icon={<PlusOutlined />}>
            主要動作
          </Button>
          <Button>次要動作</Button>
          <Button type="dashed">虛線</Button>
          <Button type="text">文字</Button>
          <Button type="link">連結</Button>
          <Button danger icon={<DeleteOutlined />}>
            危險動作
          </Button>
          <Button type="primary" disabled>
            停用
          </Button>
          <Button size="small">小按鈕</Button>
        </Flex>
      </Sample>

      <Sample title="Card、Descriptions">
        <Flex gap={token.marginMD}>
          <Card size="small" title="小卡片（size=small）" className={styles.cardFlex}>
            用於側欄屬性與摘要。
          </Card>
          <Card title="一般卡片" extra={<a>更多</a>} className={styles.cardFlex}>
            <Descriptions
              column={2}
              size="small"
              items={[
                { key: 'a', label: '物件', children: '南京復興整層住家' },
                { key: 'b', label: '租期', children: '12 個月' },
                { key: 'c', label: '月租金', children: '$42,000' },
                { key: 'd', label: '押金', children: '$84,000' },
              ]}
            />
          </Card>
        </Flex>
        <div className={styles.sampleGap}>
          <Descriptions
            bordered
            size="small"
            column={2}
            title="邊框式 Descriptions"
            items={[
              { key: 'a', label: '出租人', children: '甲方' },
              { key: 'b', label: '承租人', children: '乙方' },
              { key: 'c', label: '狀態', children: <Tag color="processing">簽署中</Tag> },
              { key: 'd', label: '更新時間', children: '2026-11-10' },
            ]}
          />
        </div>
      </Sample>

      <Sample title="Menu、Layout（亮色側欄與頂部列）">
        <Layout className={styles.layoutSample}>
          <Layout.Header>
            <Text strong>租房雲端管理平台</Text>
          </Layout.Header>
          <Layout>
            <Layout.Sider width={200} theme="light">
              <Menu
                mode="inline"
                selectedKeys={['contracts']}
                items={[
                  { key: 'home', icon: <HomeOutlined />, label: '工作台' },
                  { key: 'contracts', icon: <FileTextOutlined />, label: '合約' },
                  { key: 'properties', icon: <HomeOutlined />, label: '物件' },
                ]}
              />
            </Layout.Sider>
            <Layout.Content className={styles.layoutContent}>頁面內容在畫布色上，卡片是白色。</Layout.Content>
          </Layout>
        </Layout>
      </Sample>

      <Sample title="Form、Alert、Steps">
        <Flex vertical gap={token.marginLG}>
          <Steps
            current={1}
            items={[{ title: '選擇物件' }, { title: '填寫欄位' }, { title: '設定簽署' }, { title: '確認送出' }]}
          />
          <Form layout="vertical" requiredMark>
            <Flex gap={token.marginMD}>
              <Form.Item label="物件" required className={styles.formField}>
                <Select
                  placeholder="請選擇"
                  options={[
                    { value: 'a', label: '南京復興整層住家' },
                    { value: 'b', label: '信義安和小套房' },
                  ]}
                />
              </Form.Item>
              <Form.Item
                label="月租金"
                required
                validateStatus="error"
                help="請輸入大於 0 的整數"
                className={styles.formField}
              >
                <Input placeholder="42000" />
              </Form.Item>
            </Flex>
          </Form>
          <Flex vertical gap={token.marginXS}>
            <Alert type="info" showIcon title="資訊：合約送簽後，乙方先簽，甲方後簽。" />
            <Alert type="success" showIcon title="成功：已送出簽署。" />
            <Alert type="warning" showIcon title="警告：尚有一位簽署人未設定簽署區域。" />
            <Alert
              type="error"
              showIcon
              title="失敗：無法送出簽署"
              description="簽署服務沒有回應。請稍後再試，或複製為新草稿。"
            />
          </Flex>
        </Flex>
      </Sample>
    </Flex>
  );
}
