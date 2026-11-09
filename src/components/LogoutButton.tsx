'use client';

import { useState } from 'react';
import { Button } from 'antd';
import { LogoutOutlined } from '@ant-design/icons';

// 登出（MIL-103）：POST /api/auth/logout 刪除 session 列並清掉 cookie，成功後整頁導向登入頁。
// 後台殼層與屋主端殼層共用。失敗時保持原頁，按鈕恢復可按。
export default function LogoutButton({ type = 'text', label = '登出' }: { type?: 'text' | 'default'; label?: string }) {
  const [loading, setLoading] = useState(false);

  async function logout() {
    setLoading(true);
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' });
      if (!response.ok) throw new Error(String(response.status));
      window.location.assign('/login');
    } catch {
      setLoading(false);
    }
  }

  return (
    <Button type={type} icon={<LogoutOutlined />} loading={loading} onClick={() => void logout()}>
      {label}
    </Button>
  );
}
