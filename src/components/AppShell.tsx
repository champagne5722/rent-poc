'use client';

import { useEffect, useState } from 'react';
import { Badge, Button, Flex, Layout, Menu, Tooltip, Typography } from 'antd';
import {
  DashboardOutlined,
  HomeOutlined,
  FileTextOutlined,
  PlusOutlined,
  BellOutlined,
  BgColorsOutlined,
  SwapOutlined,
  ProfileOutlined,
  SafetyCertificateOutlined,
  AuditOutlined,
  IdcardOutlined,
  TeamOutlined,
  BankOutlined,
} from '@ant-design/icons';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import ShellHeader from './ShellHeader';
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
import { NOTIFICATIONS_CHANGED_EVENT } from '@/lib/notifications/client-events';
import styles from './AppShell.module.css';

const NAV_ICONS: Record<NavKey, React.ReactNode> = {
  workbench: <DashboardOutlined />,
  properties: <HomeOutlined />,
  cases: <ProfileOutlined />,
  contracts: <FileTextOutlined />,
  'payment-accounts': <BankOutlined />,
  handovers: <SwapOutlined />,
  notifications: <BellOutlined />,
  design: <BgColorsOutlined />,
};

const PERSONAL_NAV_ICONS: Record<PersonalNavKey, React.ReactNode> = {
  practitioner: <IdcardOutlined />,
};

const IDENTITY_NAV_ICONS: Record<IdentityNavKey, React.ReactNode> = {
  practice: <SafetyCertificateOutlined />,
  desk: <AuditOutlined />,
  members: <TeamOutlined />,
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

// Sider 的寬度是 antd 的屬性，沒有元件層 token，所以留在這裡當具名常數。
const SIDER_WIDTH = 224;

// 登入由 MIL-103 提供：未登入的請求在 proxy 與根 layout 就被導向 /login，到這裡的都有 session
// 後台殼層＝亮色 collapsible side menu（規格 §4，MIL-173）：antd Layout＋Sider＋Menu mode="inline"，不引入 ProLayout。
// 顏色、高度、選中態都來自 DESIGN.md 的 Layout 與 Menu token，這裡沒有色碼、px 與 inline style。
function AdminShell({ pathname, children }: { pathname: string; children: React.ReactNode }) {
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);

  const unread = useUnreadCount(pathname);
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

  // 平台營運者只處理審核台，不顯示屋主功能的選單與「建立合約」（MIL-191、MIL-185）
  const isOperator = identityKind === 'operator';

  return (
    <Layout className={styles.root}>
      <Layout.Sider theme="light" className={styles.sider} collapsible collapsed={collapsed} onCollapse={setCollapsed} width={SIDER_WIDTH}>
        <div className={collapsed ? styles.brandCollapsed : styles.brand}>
          <Typography.Text strong>{collapsed ? '租' : '租房雲端管理平台'}</Typography.Text>
        </div>

        {/* 常駐建約入口：任何頁面都看得到；收合時縮成 icon，靠 tooltip 說明。
            用 default 按鈕：DESIGN.md 規定每個畫面至多一顆 primary，primary 留給頁面自己的主要動作（MIL-185）。 */}
        {!isOperator && (
          <div className={collapsed ? styles.ctaCollapsed : styles.cta}>
            <Tooltip title={collapsed ? '建立合約' : undefined} placement="right">
              <Button
                block
                icon={<PlusOutlined />}
                // 用 router.push 而非 Link 包 Button，避免 <a> 內嵌 <button> 的無效巢狀
                onClick={() => router.push(CREATE_CONTRACT_HREF)}
              >
                {collapsed ? null : '建立合約'}
              </Button>
            </Tooltip>
          </div>
        )}

        <Menu
          mode="inline"
          selectedKeys={selected ? [selected] : []}
          items={[
            ...(isOperator ? [] : NAV_ITEMS).map((item) => {
              const badge = item.key === 'notifications' ? unread : 0;
              return {
                key: item.key,
                // 收合時只剩 icon，用小圓點提示有未讀
                icon: badge > 0 && collapsed ? <Badge dot>{NAV_ICONS[item.key]}</Badge> : NAV_ICONS[item.key],
                label: (
                  <Link href={item.href}>
                    <Flex gap="small" align="center" component="span">
                      {item.label}
                      {badge > 0 && !collapsed && <Badge count={badge} overflowCount={99} size="small" aria-label={`${badge} 則未讀`} />}
                    </Flex>
                  </Link>
                ),
              };
            }),
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
        {/* 頂部列左側是區域名稱，用次要文字色，不與頁首的頁面標題競爭。頁面標題由頁面的 PageHeader 負責（MIL-174） */}
        <ShellHeader start={<Typography.Text type="secondary">{currentLabel}</Typography.Text>} />
        <Layout.Content className={styles.content}>{children}</Layout.Content>
      </Layout>
    </Layout>
  );
}
