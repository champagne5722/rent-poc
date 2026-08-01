'use client';

import { Layout, Menu, Typography } from 'antd';
import { HomeOutlined, FileTextOutlined } from '@ant-design/icons';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

// 不做登入：打開即房東視角（見 CONTEXT.md）
export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const selected = pathname.startsWith('/contracts') ? 'contracts' : 'properties';

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Header style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <Typography.Text strong style={{ color: '#fff', fontSize: 16, whiteSpace: 'nowrap' }}>
          Rent PoC 電子簽約
        </Typography.Text>
        <Menu
          theme="dark"
          mode="horizontal"
          selectedKeys={[selected]}
          style={{ flex: 1, minWidth: 0 }}
          items={[
            { key: 'properties', icon: <HomeOutlined />, label: <Link href="/properties">物件</Link> },
            { key: 'contracts', icon: <FileTextOutlined />, label: <Link href="/contracts">合約</Link> },
          ]}
        />
      </Layout.Header>
      <Layout.Content style={{ padding: 24, maxWidth: 1200, width: '100%', margin: '0 auto' }}>
        {children}
      </Layout.Content>
    </Layout>
  );
}
