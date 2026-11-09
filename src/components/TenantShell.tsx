'use client';

import { Button, Empty, Flex, Layout, Typography, theme } from 'antd';
import { UserOutlined } from '@ant-design/icons';
import Link from 'next/link';
import { TENANT_ROOT_HREF } from '@/lib/nav';
import type { TenantSession } from '@/lib/current-tenant-session';
import IdentitySwitcher from './IdentitySwitcher';
import LogoutButton from './LogoutButton';
import styles from './TenantShell.module.css';

// 承租人端殼層（MIL-121）：沿用屋主端的上方列做法（F 線定案），沒有側邊選單，也沒有「建立合約」。
// 沒有承租人身分時，所有承租人端頁面都改顯示空狀態，不渲染頁面內容。
export default function TenantShell({
  session,
  children,
}: {
  session: TenantSession | null;
  children: React.ReactNode;
}) {
  const { token } = theme.useToken();

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <header
        className={styles.bar}
        style={{ background: token.colorBgContainer, borderBottom: `1px solid ${token.colorSplit}` }}
      >
        <Link href={TENANT_ROOT_HREF} className={styles.brand} style={{ color: token.colorText }}>
          <Typography.Text strong>租房雲端管理平台</Typography.Text>
        </Link>

        {session && (
          // 用一般 div：antd Flex 自帶的 margin 重設會蓋掉 margin-left: auto
          <div className={styles.identity}>
            <UserOutlined style={{ color: token.colorTextSecondary }} aria-hidden />
            <Typography.Text ellipsis={{ tooltip: session.displayName }}>{session.displayName}</Typography.Text>
            <IdentitySwitcher />
            <LogoutButton />
          </div>
        )}
      </header>

      <Layout.Content className={styles.content}>{session ? children : <NoTenantIdentity />}</Layout.Content>
    </Layout>
  );
}

function NoTenantIdentity() {
  return (
    <Flex justify="center" style={{ paddingBlock: 48 /* xxl */ }}>
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <Flex vertical gap={4}>
            <Typography.Text strong>沒有承租人身分</Typography.Text>
            <Typography.Text type="secondary">目前使用的身分不是承租人，所以看不到承租人端的案件。</Typography.Text>
          </Flex>
        }
      >
        <Button href="/">回到工作台</Button>
      </Empty>
    </Flex>
  );
}
