// 後台殼層的導覽定義（規格 §4）：一級頁面＝工作台／物件／合約，層級少於三層，不用 breadcrumb。
// 純資料＋純函式放這裡，讓高亮規則可以直接測（見 nav.test.ts）；icon 留在 AppShell.tsx。

export type NavKey = 'workbench' | 'properties' | 'contracts';

export type NavItem = {
  key: NavKey;
  label: string;
  href: string;
};

export const NAV_ITEMS: readonly NavItem[] = [
  // 工作台是預設落地頁；現況 / redirect 到 /properties，工作台頁另開票實作
  { key: 'workbench', label: '工作台', href: '/' },
  { key: 'properties', label: '物件', href: '/properties' },
  { key: 'contracts', label: '合約', href: '/contracts' },
];

// 常駐建約 CTA 的目的地＝建約 wizard 的第①步（選物件與範本，規格 §7）
export const CREATE_CONTRACT_HREF = '/contracts/new';

function matches(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** 依目前路徑決定側邊選單要高亮哪一項；不屬於任何一級頁面時回傳 null。 */
export function resolveNavKey(pathname: string): NavKey | null {
  if (pathname === '/') return 'workbench';
  const hit = NAV_ITEMS.find((item) => item.href !== '/' && matches(pathname, item.href));
  return hit?.key ?? null;
}
