'use client';

// 從物件建立案件的入口（MIL-209、MIL-205，ADR-0029 決議 1）。三處共用：物件詳情的案件區、物件列表的租賃單位列、物件列表的物件列。
// 入口列出這個組織對這個物件能建的案件種類，文字用法定名稱（「建立租賃案件」等），名稱取自狀態呈現表。
// 選了種類就進建約精靈：/contracts/new?property=<物件 ID>&kind=<案件種類>。伺服端建立時還會再檢查一次。
//
// 兩種用法：
// - 傳 `kinds`：種類已知（物件詳情由 server component 載入）。沒有可建的種類時不畫入口。
//   只有一種時是一顆直接進精靈的按鈕，多種時是選單。
// - 不傳 `kinds`：物件列表的每一列不預先查。使用者打開選單時才查這一個物件的 `available_case_kinds`。

import { useState } from 'react';
import { Button, Dropdown, type ButtonProps, type MenuProps } from 'antd';
import { DownOutlined } from '@ant-design/icons';
import { useRouter } from 'next/navigation';
import { createCaseLabel, newCaseHref, orderedCaseKinds } from '@/lib/property-case-entry';
import type { PropertyCaseKind } from '@/lib/types';

export interface CreateCaseEntryProps {
  propertyId: string;
  /** 已知的能建種類。沒傳時，打開選單才查。 */
  kinds?: readonly PropertyCaseKind[];
  type?: ButtonProps['type'];
  size?: ButtonProps['size'];
  /** 選單形式的按鈕文字。預設「建立案件」。 */
  label?: string;
}

type Lookup = { state: 'idle' } | { state: 'loading' } | { state: 'ready'; kinds: PropertyCaseKind[] } | { state: 'failed' };

export default function CreateCaseEntry({ propertyId, kinds, type = 'default', size, label = '建立案件' }: CreateCaseEntryProps) {
  const router = useRouter();
  const [lookup, setLookup] = useState<Lookup>({ state: 'idle' });

  const go = (kind: PropertyCaseKind) => router.push(newCaseHref(propertyId, kind));

  const load = async () => {
    setLookup({ state: 'loading' });
    try {
      const res = await fetch(`/api/properties/${propertyId}`);
      const json = await res.json();
      if (!res.ok) throw new Error('lookup failed');
      setLookup({ state: 'ready', kinds: orderedCaseKinds(json.data?.available_case_kinds ?? []) });
    } catch {
      setLookup({ state: 'failed' });
    }
  };

  if (kinds) {
    const known = orderedCaseKinds(kinds);
    if (known.length === 0) return null;
    if (known.length === 1) {
      return (
        <Button type={type} size={size} onClick={() => go(known[0]!)}>
          {createCaseLabel(known[0]!)}
        </Button>
      );
    }
    return <EntryMenu label={label} type={type} size={size} items={known.map((kind) => menuItem(kind, go))} />;
  }

  // 打開選單才查，查過的結果留著。失敗時下次打開再查一次
  const items: MenuProps['items'] =
    lookup.state === 'ready'
      ? lookup.kinds.length > 0
        ? lookup.kinds.map((kind) => menuItem(kind, go))
        : [{ key: 'none', label: '目前沒有可建立的案件種類', disabled: true }]
      : lookup.state === 'failed'
        ? [{ key: 'failed', label: '查詢失敗，請再打開一次', disabled: true }]
        : [{ key: 'loading', label: '查詢中…', disabled: true }];

  return (
    <EntryMenu
      label={label}
      type={type}
      size={size}
      items={items}
      onOpen={() => {
        if (lookup.state === 'idle' || lookup.state === 'failed') void load();
      }}
    />
  );
}

function menuItem(kind: PropertyCaseKind, go: (kind: PropertyCaseKind) => void): NonNullable<MenuProps['items']>[number] {
  return { key: kind, label: createCaseLabel(kind), onClick: () => go(kind) };
}

function EntryMenu({
  label,
  type,
  size,
  items,
  onOpen,
}: {
  label: string;
  type: ButtonProps['type'];
  size: ButtonProps['size'];
  items: MenuProps['items'];
  onOpen?: () => void;
}) {
  return (
    <Dropdown menu={{ items }} trigger={['click']} onOpenChange={(open) => open && onOpen?.()}>
      <Button type={type} size={size}>
        {label}
        <DownOutlined aria-hidden />
      </Button>
    </Dropdown>
  );
}
