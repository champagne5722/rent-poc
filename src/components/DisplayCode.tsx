'use client';

import { useEffect, useState } from 'react';
import { Typography } from 'antd';
import type { Property } from '@/lib/types';

// 租賃單位的顯示編碼（ADR-0025 決議 12）。格式 `F18-7K3QZP`，不含段碼與建號。
// 只供口頭溝通與畫面對照，不保證唯一；系統內查詢與網址一律用 ULID。

const HINT = '顯示編碼只供口頭溝通，不保證唯一';

/** 待驗證的錨點沒有縣市與鄉鎮編碼，補建號後才產生，所以 code 可能是 null。 */
export function DisplayCode({ code }: { code: string | null | undefined }) {
  if (!code) return <Typography.Text type="secondary">補建號後產生</Typography.Text>;
  return (
    <Typography.Text code title={HINT} style={{ whiteSpace: 'nowrap' }}>
      {code}
    </Typography.Text>
  );
}

/** 合約列表用：物件 ID 到顯示編碼的對照。物件載入前、讀不到的物件都不在對照表裡。 */
export function useDisplayCodes(): Map<string, string | null> {
  const [codes, setCodes] = useState<Map<string, string | null>>(new Map());
  useEffect(() => {
    let stale = false;
    void (async () => {
      const res = await fetch('/api/properties');
      if (!res.ok || stale) return;
      const json = (await res.json()) as { data?: Property[] };
      if (stale) return;
      setCodes(new Map((json.data ?? []).map((p) => [p.id, p.unit?.display_code ?? null])));
    })();
    return () => {
      stale = true;
    };
  }, []);
  return codes;
}

/** 合約詳情頁用：單一物件的顯示編碼。物件 ID 為空或讀不到時回 undefined（畫面不顯示這一列）。 */
export function useDisplayCode(propertyId: string | null | undefined): string | null | undefined {
  const [state, setState] = useState<{ id: string; code: string | null } | null>(null);
  useEffect(() => {
    if (!propertyId) return;
    let stale = false;
    void (async () => {
      const res = await fetch(`/api/properties/${propertyId}`);
      if (!res.ok || stale) return;
      const json = (await res.json()) as { data?: Property };
      if (stale || !json.data) return;
      setState({ id: propertyId, code: json.data.unit?.display_code ?? null });
    })();
    return () => {
      stale = true;
    };
  }, [propertyId]);
  return state && state.id === propertyId ? state.code : undefined;
}
