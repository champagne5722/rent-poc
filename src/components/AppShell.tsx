'use client';

import { useEffect, useState } from 'react';
import { Badge, Button, Flex, Layout, Menu, Tooltip, Typography, theme } from 'antd';
import {
  DashboardOutlined,
  HomeOutlined,
  FileTextOutlined,
  PlusOutlined,
  BellOutlined,
  BgColorsOutlined,
  SwapOutlined,
  BankOutlined,
} from '@ant-design/icons';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { NAV_ITEMS, CREATE_CONTRACT_HREF, resolveNavKey, shellFor, type NavKey } from '@/lib/nav';
import { NOTIFICATIONS_CHANGED_EVENT } from '@/lib/notifications/client-events';

const NAV_ICONS: Record<NavKey, React.ReactNode> = {
  workbench: <DashboardOutlined />,
  properties: <HomeOutlined />,
  contracts: <FileTextOutlined />,
  'payment-accounts': <BankOutlined />,
  handovers: <SwapOutlined />,
  notifications: <BellOutlined />,
  design: <BgColorsOutlined />,
};

// 殼層依路徑分派（MIL-94）：/owner 底下交給 src/app/owner/layout.tsx 掛 OwnerShell，
// 因為屋主身分要在 server 端讀，只限屋主端的請求；其他路徑用後台殼層。
export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (shellFor(pathname) === 'owner') return children;
  return <AdminShell pathname={pathname}>{children}</AdminShell>;
}

// 未讀數（MIL-120）：換頁時重新讀，通知頁標已讀後靠事件通知殼層更新。讀不到（沒登入、網路錯誤）就不顯示徽章
function useUnreadCount(pathname: string): number {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch('/api/notifications/unread-count')
        .then((res) => (res.ok ? res.json() : null))
        .then((body: { data?: { unread?: number } } | null) => {
          if (!cancelled) setUnread(body?.data?.unread ?? 0);
        })
        .catch(() => undefined);
    const reload = () => void load();
    reload();
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, reload);
    return () => {
      cancelled = true;
      window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, reload);
    };
  }, [pathname]);
  return unread;
}

// 不做登入：打開即屋主視角（見 GLOSSARY.md）
// 後台殼層＝深色 collapsible side menu（規格 §4）：antd Layout＋Sider＋Menu mode="inline"，不引入 ProLayout
function AdminShell({ pathname, children }: { pathname: string; children: React.ReactNode }) {
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const { token } = theme.useToken();

  const unread = useUnreadCount(pathname);
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
          items={NAV_ITEMS.map((item) => {
            const badge = item.key === 'notifications' ? unread : 0;
            return {
              key: item.key,
              // 收合時只剩 icon，用小圓點提示有未讀
              icon: badge > 0 && collapsed ? <Badge dot offset={[2, -2]}>{NAV_ICONS[item.key]}</Badge> : NAV_ICONS[item.key],
              label: (
                <Link href={item.href}>
                  <Flex gap={8 /* xs */} align="center" component="span">
                    {item.label}
                    {badge > 0 && !collapsed && <Badge count={badge} overflowCount={99} size="small" aria-label={`${badge} 則未讀`} />}
                  </Flex>
                </Link>
              ),
            };
          })}
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
