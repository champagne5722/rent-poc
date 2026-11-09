'use client';

import { useEffect, useState } from 'react';
import { Button, Dropdown, type MenuProps } from 'antd';
import { DownOutlined, SwapOutlined } from '@ant-design/icons';

// 身分切換器（MIL-106，ADR-0022 決議 6）：只列帳號真的有的身分，只有一種身分時不顯示。
// 後台殼層（AccountBar）與屋主端殼層（OwnerShell）各放一個。只有切換動作，不決定殼層怎麼排版（F 線）。
// 選擇存在 session：POST /api/auth/identity 成功後整頁導向該身分的落地頁，殼層與資料都依新身分重新載入。

interface IdentityItem {
  kind: 'owner' | 'practice' | 'party' | 'operator';
  label: string;
  orgId?: string;
}

interface IdentityList {
  current: IdentityItem | null;
  options: IdentityItem[];
}

const KIND_LABEL: Record<IdentityItem['kind'], string> = {
  owner: '屋主',
  practice: '經理人',
  party: '承租人',
  operator: '平台',
};

const sameItem = (a: IdentityItem, b: IdentityItem | null) => b !== null && a.kind === b.kind && a.orgId === b.orgId;

export default function IdentitySwitcher() {
  const [list, setList] = useState<IdentityList | null>(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/auth/identities');
        if (!response.ok) return;
        const body = (await response.json()) as { data?: IdentityList };
        if (!cancelled && body.data) setList(body.data);
      } catch {
        // 切換器只是輔助入口，抓不到就不顯示
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!list || list.options.length < 2) return null;

  async function choose(item: IdentityItem) {
    if (switching || sameItem(item, list?.current ?? null)) return;
    setSwitching(true);
    try {
      const response = await fetch('/api/auth/identity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: item.kind === 'owner' || item.kind === 'practice' ? 'org' : item.kind, orgId: item.orgId }),
      });
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as { data?: { redirectTo?: string } };
      window.location.assign(body.data?.redirectTo ?? '/');
    } catch {
      setSwitching(false);
    }
  }

  const items: MenuProps['items'] = list.options.map((item, index) => ({
    key: String(index),
    label: item.kind === 'operator' || item.kind === 'party' ? item.label : `${item.label}（${KIND_LABEL[item.kind]}）`,
    disabled: sameItem(item, list.current),
  }));

  const currentLabel = list.current?.label ?? '選擇身分';

  return (
    <Dropdown
      trigger={['click']}
      menu={{
        items,
        selectedKeys: list.current ? [String(list.options.findIndex((o) => sameItem(o, list.current)))] : [],
        onClick: ({ key }) => void choose(list.options[Number(key)]),
      }}
    >
      <Button type="text" icon={<SwapOutlined />} loading={switching} aria-label={`切換身分，目前是${currentLabel}`}>
        {currentLabel}
        <DownOutlined />
      </Button>
    </Dropdown>
  );
}
