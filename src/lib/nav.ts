// 後台殼層的導覽定義（規格 §4）：一級頁面＝工作台／物件／合約，層級少於三層，不用 breadcrumb。
// 純資料＋純函式放這裡，讓高亮規則可以直接測（見 nav.test.ts）；icon 留在 AppShell.tsx。

export type NavKey = 'workbench' | 'properties' | 'contracts' | 'handovers' | 'notifications' | 'design';

export type NavItem = {
  key: NavKey;
  label: string;
  href: string;
};

export const NAV_ITEMS: readonly NavItem[] = [
  // 工作台是登入後的預設落地頁，/ 直接渲染工作台（規格 §5）
  { key: 'workbench', label: '工作台', href: '/' },
  { key: 'properties', label: '物件', href: '/properties' },
  { key: 'contracts', label: '合約', href: '/contracts' },
  // 移交（MIL-94）：接收方看移交給我的案件與我交出的案件，經理人視角
  { key: 'handovers', label: '移交', href: '/handovers' },
  // 通知（MIL-120）：站內通知清單，選單項帶未讀數
  { key: 'notifications', label: '通知', href: '/notifications' },
  // 設計樣式頁：呈現 DESIGN.md 目前的 token 與元件樣式，供調整佈局與字級時對照
  { key: 'design', label: '設計', href: '/design' },
];

// 常駐建約 CTA 的目的地＝建約 wizard 的第①步（選物件與範本，規格 §7）
export const CREATE_CONTRACT_HREF = '/contracts/new';

function matches(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

// 殼層分派（MIL-94）：屋主端在 /owner 底下，其他路徑維持後台殼層。既有頁面不搬目錄。
export type ShellKind = 'admin' | 'owner';

export const OWNER_ROOT_HREF = '/owner';

export function shellFor(pathname: string): ShellKind {
  return matches(pathname, OWNER_ROOT_HREF) ? 'owner' : 'admin';
}

// 屋主端選單：只有資產總覽與移交，不放「建立合約」（P0-09 不允許屋主替代管案件擬約）
export type OwnerNavKey = 'overview' | 'handovers';

export type OwnerNavItem = {
  key: OwnerNavKey;
  label: string;
  href: string;
};

export const OWNER_NAV_ITEMS: readonly OwnerNavItem[] = [
  { key: 'overview', label: '資產總覽', href: OWNER_ROOT_HREF },
  { key: 'handovers', label: '移交', href: `${OWNER_ROOT_HREF}/handovers` },
];

/** 屋主端上方列的高亮；/owner 本身是資產總覽，其他子路徑比照後台的前綴規則。 */
export function resolveOwnerNavKey(pathname: string): OwnerNavKey | null {
  if (pathname === OWNER_ROOT_HREF || pathname === `${OWNER_ROOT_HREF}/`) return 'overview';
  const hit = OWNER_NAV_ITEMS.find(
    (item) => item.href !== OWNER_ROOT_HREF && matches(pathname, item.href),
  );
  return hit?.key ?? null;
}

/** 依目前路徑決定側邊選單要高亮哪一項；不屬於任何一級頁面時回傳 null。 */
export function resolveNavKey(pathname: string): NavKey | null {
  if (pathname === '/') return 'workbench';
  const hit = NAV_ITEMS.find((item) => item.href !== '/' && matches(pathname, item.href));
  return hit?.key ?? null;
}
