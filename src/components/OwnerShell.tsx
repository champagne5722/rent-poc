'use client';

import { Button, Empty, Flex, Layout, Menu, Typography, theme } from 'antd';
import { TeamOutlined, UserOutlined } from '@ant-design/icons';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { MEMBERS_HREF, OWNER_NAV_ITEMS, OWNER_ROOT_HREF, resolveOwnerNavKey } from '@/lib/nav';
import type { OwnerSession } from '@/lib/owner-session';
import IdentitySwitcher from './IdentitySwitcher';
import LogoutButton from './LogoutButton';
import styles from './OwnerShell.module.css';

// 屋主端殼層（MIL-94）：上方列，沒有側邊選單，也沒有「建立合約」。375px 寬時不得水平捲動。
// 沒有屋主身分時，所有屋主端頁面都改顯示空狀態，不渲染頁面內容。
export default function OwnerShell({
  session,
  children,
}: {
  session: OwnerSession | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { token } = theme.useToken();
  const selected = resolveOwnerNavKey(pathname);

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <header
        className={styles.bar}
        style={{ background: token.colorBgContainer, borderBottom: `1px solid ${token.colorSplit}` }}
      >
        <Link href={OWNER_ROOT_HREF} className={styles.brand} style={{ color: token.colorText }}>
          <Typography.Text strong>租房雲端管理平台</Typography.Text>
        </Link>

        {session && (
          <nav className={styles.nav} aria-label="屋主端選單">
            <Menu
              mode="horizontal"
              selectedKeys={selected ? [selected] : []}
              style={{ borderBottom: 'none', background: 'transparent' }}
              items={OWNER_NAV_ITEMS.map((item) => ({
                key: item.key,
                label: <Link href={item.href}>{item.label}</Link>,
              }))}
            />
          </nav>
        )}

        {session && (
          // 用一般 div：antd Flex 自帶的 margin 重設會蓋掉 margin-left: auto
          <div className={styles.identity}>
            <UserOutlined style={{ color: token.colorTextSecondary }} aria-hidden />
            <Typography.Text ellipsis={{ tooltip: session.displayName }}>
              {session.displayName}
            </Typography.Text>
            <IdentitySwitcher />
            <Button type="text" icon={<TeamOutlined />} href={MEMBERS_HREF}>
              成員
            </Button>
            <LogoutButton />
          </div>
        )}
      </header>

      <Layout.Content className={styles.content}>
        {session ? children : <NoOwnerIdentity />}
      </Layout.Content>
    </Layout>
  );
}

function NoOwnerIdentity() {
  return (
    <Flex justify="center" style={{ paddingBlock: 48 /* xxl */ }}>
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <Flex vertical gap={4}>
            <Typography.Text strong>沒有屋主身分</Typography.Text>
            <Typography.Text type="secondary">
              目前的帳號不是任何租賃單位的屋主，所以看不到資產總覽與移交。
            </Typography.Text>
          </Flex>
        }
      >
        {/* antd Button 帶 href 時渲染成 <a>，顏色走 token，不出現 <a> 包 <button> */}
        <Button href="/">回到後台</Button>
      </Empty>
    </Flex>
  );
}
