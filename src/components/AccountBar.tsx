'use client';

import { useEffect, useState } from 'react';
import { Button, Flex, Typography } from 'antd';
import { TeamOutlined, UserOutlined } from '@ant-design/icons';
import { MEMBERS_HREF } from '@/lib/nav';
import IdentitySwitcher from './IdentitySwitcher';
import LogoutButton from './LogoutButton';
import styles from './AccountBar.module.css';

// 頂部列右側：目前登入者的名稱、身分切換器（MIL-106）、成員管理入口與登出（MIL-103）。
// 後台與屋主端共用（MIL-173）。屋主端在 server 端已讀到名稱，從 knownName 帶入；後台省略它，名稱來自 GET /api/auth/me，載入前只顯示登出。
export default function AccountBar({ knownName }: { knownName?: string }) {
  const [fetchedName, setFetchedName] = useState<string | null>(null);

  useEffect(() => {
    if (knownName !== undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/auth/me');
        if (!response.ok) return;
        const body = (await response.json()) as { data?: { displayName?: string; orgName?: string | null } };
        const { displayName, orgName } = body.data ?? {};
        if (!cancelled && displayName) setFetchedName(orgName ? `${displayName}（${orgName}）` : displayName);
      } catch {
        // 名稱只是輔助資訊，抓不到就不顯示
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [knownName]);

  const name = knownName ?? fetchedName;

  return (
    <Flex align="center" gap="small" justify="flex-end" wrap="wrap">
      {name && (
        <Flex align="center" gap="small" className={styles.name}>
          <Typography.Text type="secondary">
            <UserOutlined aria-hidden />
          </Typography.Text>
          <Typography.Text ellipsis={{ tooltip: name }}>{name}</Typography.Text>
        </Flex>
      )}
      <IdentitySwitcher />
      <Button type="text" icon={<TeamOutlined />} href={MEMBERS_HREF}>
        成員
      </Button>
      <LogoutButton />
    </Flex>
  );
}
