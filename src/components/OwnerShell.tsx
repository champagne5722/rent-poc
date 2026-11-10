'use client';

import { Button, Empty, Flex, Layout, Menu, Typography } from 'antd';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { OWNER_NAV_ITEMS, OWNER_ROOT_HREF, resolveOwnerNavKey } from '@/lib/nav';
import type { OwnerSession } from '@/lib/owner-session';
import ShellHeader from './ShellHeader';
import styles from './OwnerShell.module.css';

// 屋主端殼層（MIL-94，MIL-173）：上方列，沒有側邊選單，也沒有「建立合約」。頂部列與後台共用 ShellHeader。375px 寬時不得水平捲動。
// 沒有屋主身分時，所有屋主端頁面都改顯示空狀態，不渲染頁面內容。
export default function OwnerShell({
  session,
  children,
}: {
  session: OwnerSession | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const selected = resolveOwnerNavKey(pathname);

  return (
    <Layout className={styles.root}>
      <ShellHeader
        start={
          <Link href={OWNER_ROOT_HREF} className={styles.brand}>
            <Typography.Text strong>租房雲端管理平台</Typography.Text>
          </Link>
        }
        nav={
          session && (
            <nav aria-label="屋主端選單">
              <Menu
                mode="horizontal"
                className={styles.menu}
                selectedKeys={selected ? [selected] : []}
                items={OWNER_NAV_ITEMS.map((item) => ({
                  key: item.key,
                  label: <Link href={item.href}>{item.label}</Link>,
                }))}
              />
            </nav>
          )
        }
        accountName={session?.displayName}
      />

      <Layout.Content className={styles.content}>
        {session ? children : <NoOwnerIdentity />}
      </Layout.Content>
    </Layout>
  );
}

function NoOwnerIdentity() {
  return (
    <Flex justify="center" className={styles.empty}>
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <Flex vertical gap="small">
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
