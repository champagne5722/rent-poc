'use client';

import { useEffect, useState } from 'react';
import { Button, Flex, Typography } from 'antd';
import { TeamOutlined, UserOutlined } from '@ant-design/icons';
import { MEMBERS_HREF } from '@/lib/nav';
import IdentitySwitcher from './IdentitySwitcher';
import LogoutButton from './LogoutButton';

// 後台殼層右上角：目前登入者的名稱、身分切換器（MIL-106）、成員管理入口與登出（MIL-103）。名稱來自 GET /api/auth/me，載入前只顯示登出。
export default function AccountBar() {
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/auth/me');
        if (!response.ok) return;
        const body = (await response.json()) as { data?: { displayName?: string; orgName?: string | null } };
        const { displayName, orgName } = body.data ?? {};
        if (!cancelled && displayName) setName(orgName ? `${displayName}（${orgName}）` : displayName);
      } catch {
        // 名稱只是輔助資訊，抓不到就不顯示
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Flex align="center" gap="small" style={{ marginInlineStart: 'auto' }}>
      {name && (
        <Flex align="center" gap="small">
          <UserOutlined aria-hidden />
          <Typography.Text>{name}</Typography.Text>
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
