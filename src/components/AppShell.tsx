'use client';

import { useEffect, useState } from 'react';
import { Button, Layout, Menu, Tooltip, Typography, theme } from 'antd';
import {
  DashboardOutlined,
  HomeOutlined,
  FileTextOutlined,
  PlusOutlined,
  BgColorsOutlined,
  SwapOutlined,
  ProfileOutlined,
  SafetyCertificateOutlined,
  AuditOutlined,
  IdcardOutlined,
} from '@ant-design/icons';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import AccountBar from './AccountBar';
import { isAuthScreen } from '@/lib/auth/auth-screens';
import {
  NAV_ITEMS,
  CREATE_CONTRACT_HREF,
  identityNavItems,
  personalNavItems,
  resolveIdentityNavKey,
  resolvePersonalNavKey,
  resolveNavKey,
  resolvePageTitle,
  shellFor,
  type IdentityNavKey,
  type NavKey,
  type PersonalNavKey,
} from '@/lib/nav';

const NAV_ICONS: Record<NavKey, React.ReactNode> = {
  workbench: <DashboardOutlined />,
  properties: <HomeOutlined />,
  cases: <ProfileOutlined />,
  contracts: <FileTextOutlined />,
  handovers: <SwapOutlined />,
  design: <BgColorsOutlined />,
};

const PERSONAL_NAV_ICONS: Record<PersonalNavKey, React.ReactNode> = {
  practitioner: <IdcardOutlined />,
};

const IDENTITY_NAV_ICONS: Record<IdentityNavKey, React.ReactNode> = {
  practice: <SafetyCertificateOutlined />,
  desk: <AuditOutlined />,
};

// 殼層依路徑分派（MIL-94，MIL-121）：/owner 底下交給 src/app/owner/layout.tsx 掛 OwnerShell，
// /tenant 底下交給 src/app/tenant/layout.tsx 掛 TenantShell，因為這兩種身分要在 server 端讀；其他路徑用後台殼層。
export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // 登入頁與 demo 驗證碼頁還沒有登入身分，不套任何殼層（MIL-103）
  if (isAuthScreen(pathname)) return children;
  // 屋主端與承租人端的殼層由各自的 layout 掛（src/app/owner/layout.tsx、src/app/tenant/layout.tsx）
  if (shellFor(pathname) !== 'admin') return children;
  return <AdminShell pathname={pathname}>{children}</AdminShell>;
}

// 登入由 MIL-103 提供：未登入的請求在 proxy 與根 layout 就被導向 /login，到這裡的都有 session
// 後台殼層＝深色 collapsible side menu（規格 §4）：antd Layout＋Sider＋Menu mode="inline"，不引入 ProLayout
function AdminShell({ pathname, children }: { pathname: string; children: React.ReactNode }) {
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const { token } = theme.useToken();

  const selected = resolveNavKey(pathname) ?? resolveIdentityNavKey(pathname) ?? resolvePersonalNavKey(pathname);
  const currentLabel = resolvePageTitle(pathname);

  // 執業主體與審核台的入口依目前身分顯示（MIL-109）。身分載入前不顯示，抓不到也不顯示
  const [identityKind, setIdentityKind] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/auth/identities');
        if (!response.ok) return;
        const body = (await response.json()) as { data?: { current?: { kind?: string } | null } };
        if (!cancelled) setIdentityKind(body.data?.current?.kind ?? null);
      } catch {
        // 入口只是方便，抓不到就不顯示
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
          items={[
            ...NAV_ITEMS.map((item) => ({
              key: item.key,
              icon: NAV_ICONS[item.key],
              label: <Link href={item.href}>{item.label}</Link>,
            })),
            ...identityNavItems(identityKind).map((item) => ({
              key: item.key,
              icon: IDENTITY_NAV_ICONS[item.key],
              label: <Link href={item.href}>{item.label}</Link>,
            })),
            ...personalNavItems(identityKind).map((item) => ({
              key: item.key,
              icon: PERSONAL_NAV_ICONS[item.key],
              label: <Link href={item.href}>{item.label}</Link>,
            })),
          ]}
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
          <AccountBar />
        </Layout.Header>
        <Layout.Content style={{ padding: 24 }}>{children}</Layout.Content>
      </Layout>
    </Layout>
  );
}
