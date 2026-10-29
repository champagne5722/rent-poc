'use client';

import { useState } from 'react';
import { Button, Layout, Menu, Tooltip, Typography, theme } from 'antd';
import {
  DashboardOutlined,
  HomeOutlined,
  FileTextOutlined,
  PlusOutlined,
  BgColorsOutlined,
} from '@ant-design/icons';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { NAV_ITEMS, CREATE_CONTRACT_HREF, resolveNavKey, type NavKey } from '@/lib/nav';

const NAV_ICONS: Record<NavKey, React.ReactNode> = {
  workbench: <DashboardOutlined />,
  properties: <HomeOutlined />,
  contracts: <FileTextOutlined />,
  design: <BgColorsOutlined />,
};

// 不做登入：打開即房東視角（見 GLOSSARY.md）
// 殼層＝深色 collapsible side menu（規格 §4）：antd Layout＋Sider＋Menu mode="inline"，不引入 ProLayout
export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const { token } = theme.useToken();

  const selected = resolveNavKey(pathname);
  const currentLabel = NAV_ITEMS.find((item) => item.key === selected)?.label ?? '';

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider collapsible collapsed={collapsed} onCollapse={setCollapsed} width={220}>
        <div
          style={{
            height: 56,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            fontWeight: 600,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
          }}
        >
          {collapsed ? '租' : '租房雲端管理平台'}
        </div>

        {/* 常駐建約 CTA：任何頁面都看得到；收合時縮成 icon，靠 tooltip 說明 */}
        <div style={{ padding: collapsed ? '0 8px 12px' : '0 16px 12px' }}>
          <Tooltip title={collapsed ? '建立合約' : undefined} placement="right">
            <Button
              type="primary"
              block
              icon={<PlusOutlined />}
              // 用 router.push 而非 Link 包 Button，避免 <a> 內嵌 <button> 的無效巢狀
              onClick={() => router.push(CREATE_CONTRACT_HREF)}
            >
              {collapsed ? null : '建立合約'}
            </Button>
          </Tooltip>
        </div>

        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={selected ? [selected] : []}
          items={NAV_ITEMS.map((item) => ({
            key: item.key,
            icon: NAV_ICONS[item.key],
            label: <Link href={item.href}>{item.label}</Link>,
          }))}
        />
      </Layout.Sider>

      <Layout>
        <Layout.Header
          style={{
            background: token.colorBgContainer,
            borderBottom: `1px solid ${token.colorSplit}`,
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <Typography.Title level={5} style={{ margin: 0 }}>
            {currentLabel}
          </Typography.Title>
        </Layout.Header>
        <Layout.Content style={{ padding: 24 }}>{children}</Layout.Content>
      </Layout>
    </Layout>
  );
}
