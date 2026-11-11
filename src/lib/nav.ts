// 後台殼層的導覽定義（規格 §4）：一級頁面＝工作台／物件／合約，層級少於三層，不用 breadcrumb。
// 純資料＋純函式放這裡，讓高亮規則可以直接測（見 nav.test.ts）；icon 留在 AppShell.tsx。
//
// 選單項目登記在 `./nav/<模組>.ts`，每個模組一個檔。這個檔只負責組合與放判斷函式，不放項目內容。
// 新模組登記選單項目的步驟（MIL-164）：
//   1. 新增 `./nav/<模組>.ts`，匯出 `export const <模組>Nav = { admin: [...] } as const satisfies NavRegistration`。
//      `admin` 是後台側邊選單，`owner` 是屋主端上方列，`identity` 與 `personal` 是依身分才出現的入口，四個欄位都可省略。
//   2. 在下面加一行 import，再在 NAV_MODULES 加一行。
//   3. NavKey 等型別由 NAV_MODULES 推出來，不用手寫。AppShell.tsx 的 NAV_ICONS 要補新 key 的 icon，tsc 會提醒。
// NAV_MODULES 的排列順序就是畫面上的選單順序，所以依畫面順序插入，不依字母順序。
// 兩個模組同時插在相鄰的兩行時，git 會要求手動解衝突；插在不相鄰的位置則自動合併。

import { casesNav } from './nav/cases';
import { contractsNav } from './nav/contracts';
import { designNav } from './nav/design';
import { handoversNav } from './nav/handovers';
import { membersNav } from './nav/members';
import { notificationsNav } from './nav/notifications';
import { ownerOverviewNav } from './nav/owner-overview';
import { paymentAccountsNav } from './nav/payment-accounts';
import { DESK_HREF, PRACTICE_HREF, practiceNav } from './nav/practice';
import { PRACTITIONER_HREF, practitionerNav } from './nav/practitioner';
import { propertiesNav } from './nav/properties';
import { requestsNav } from './nav/requests';
import { OWNER_ROOT_HREF, type IdentityKind, type NavRegistration } from './nav/shared';
import { workbenchNav } from './nav/workbench';

export { DESK_HREF, OWNER_ROOT_HREF, PRACTICE_HREF, PRACTITIONER_HREF };

const NAV_MODULES = [
  workbenchNav,
  propertiesNav,
  casesNav,
  contractsNav,
  requestsNav,
  paymentAccountsNav,
  ownerOverviewNav,
  handoversNav,
  notificationsNav,
  designNav,
  practiceNav,
  practitionerNav,
  membersNav,
] as const;

type NavModule = (typeof NAV_MODULES)[number];
type ItemsOf<M, K extends keyof NavRegistration> = M extends { readonly [P in K]: readonly (infer I)[] } ? I : never;

/** 依 NAV_MODULES 的順序，收集每個模組在某個位置登記的項目。 */
function collect<K extends keyof NavRegistration>(position: K): readonly NonNullable<NavRegistration[K]>[number][] {
  return NAV_MODULES.flatMap((m) => (m as NavRegistration)[position] ?? []);
}

export type NavKey = ItemsOf<NavModule, 'admin'>['key'];

export type NavItem = {
  key: NavKey;
  label: string;
  href: string;
};

export const NAV_ITEMS: readonly NavItem[] = collect('admin') as readonly NavItem[];

// 成員管理（MIL-106）：後台殼層與屋主端殼層的 header 各有一個入口，頁面用後台殼層。
export const MEMBERS_HREF = '/settings/members';
const MEMBERS_TITLE = '成員管理';

// 執業主體與審核台（MIL-109）：依目前身分才出現的入口，不放進 NAV_ITEMS（它是所有身分共用的項目）。
// 項目登記在 ./nav/practice.ts。

export type IdentityNavKey = ItemsOf<NavModule, 'identity'>['key'];

export type IdentityNavItem = {
  key: IdentityNavKey;
  label: string;
  href: string;
  /** 目前身分是這個種類（或多種之一）時才顯示。 */
  identity: IdentityKind | readonly IdentityKind[];
};

export const IDENTITY_NAV_ITEMS: readonly IdentityNavItem[] = collect('identity') as readonly IdentityNavItem[];

/** 目前身分該多看到哪些入口。身分還沒載入（null）或沒有專屬入口時是空陣列。 */
export function identityNavItems(identityKind: string | null): readonly IdentityNavItem[] {
  return IDENTITY_NAV_ITEMS.filter((item) =>
    typeof item.identity === 'string' ? item.identity === identityKind : (item.identity as readonly string[]).includes(identityKind ?? ''),
  );
}

/** 執業主體與審核台頁面的選單高亮。 */
export function resolveIdentityNavKey(pathname: string): IdentityNavKey | null {
  return IDENTITY_NAV_ITEMS.find((item) => matches(pathname, item.href))?.key ?? null;
}

// 我的證書（MIL-111）：執業主體組織的成員登錄自己的證書與任職。項目登記在 ./nav/practitioner.ts。

export type PersonalNavKey = ItemsOf<NavModule, 'personal'>['key'];

export type PersonalNavItem = {
  key: PersonalNavKey;
  label: string;
  href: string;
  identity: 'practice';
};

export const PERSONAL_NAV_ITEMS: readonly PersonalNavItem[] = collect('personal') as readonly PersonalNavItem[];

/** 目前身分該多看到哪些個人入口。身分還沒載入（null）或沒有時是空陣列。 */
export function personalNavItems(identityKind: string | null): readonly PersonalNavItem[] {
  return PERSONAL_NAV_ITEMS.filter((item) => item.identity === identityKind);
}

/** 個人入口頁面的選單高亮。 */
export function resolvePersonalNavKey(pathname: string): PersonalNavKey | null {
  return PERSONAL_NAV_ITEMS.find((item) => matches(pathname, item.href))?.key ?? null;
}

// 常駐建約 CTA 的目的地＝物件列表（MIL-209，ADR-0029 決議 1）。案件從物件往下建立，建約精靈不再選物件，
// 入口在物件列表的每一列與物件詳情，帶 `?property=&kind=` 進 /contracts/new。名稱沿用，以免動到其他畫面的匯入。
export const CREATE_CONTRACT_HREF = '/properties';

function matches(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

// 殼層分派（MIL-94）：屋主端在 /owner 底下，其他路徑維持後台殼層。既有頁面不搬目錄。
export type ShellKind = 'admin' | 'owner' | 'tenant';

// 承租人端（MIL-121）：與屋主端對稱，頁面都在 /tenant 底下，殼層由 src/app/tenant/layout.tsx 提供
export const TENANT_ROOT_HREF = '/tenant';

export function shellFor(pathname: string): ShellKind {
  if (matches(pathname, OWNER_ROOT_HREF)) return 'owner';
  if (matches(pathname, TENANT_ROOT_HREF)) return 'tenant';
  return 'admin';
}

// 屋主端選單項目登記在 ./nav/owner-overview.ts 與 ./nav/handovers.ts。
export type OwnerNavKey = ItemsOf<NavModule, 'owner'>['key'];

export type OwnerNavItem = {
  key: OwnerNavKey;
  label: string;
  href: string;
};

export const OWNER_NAV_ITEMS: readonly OwnerNavItem[] = collect('owner') as readonly OwnerNavItem[];

/** 屋主端上方列的高亮；/owner 本身是資產總覽，其他子路徑比照後台的前綴規則。 */
export function resolveOwnerNavKey(pathname: string): OwnerNavKey | null {
  if (pathname === OWNER_ROOT_HREF || pathname === `${OWNER_ROOT_HREF}/`) return 'overview';
  const hit = OWNER_NAV_ITEMS.find(
    (item) => item.href !== OWNER_ROOT_HREF && matches(pathname, item.href),
  );
  return hit?.key ?? null;
}

/** 後台 header 的頁面標題：一級頁面用選單標籤，成員管理不在選單內，另外給標題。 */
export function resolvePageTitle(pathname: string): string {
  if (matches(pathname, MEMBERS_HREF)) return MEMBERS_TITLE;
  const identityKey = resolveIdentityNavKey(pathname);
  if (identityKey) return IDENTITY_NAV_ITEMS.find((item) => item.key === identityKey)?.label ?? '';
  const personalKey = resolvePersonalNavKey(pathname);
  if (personalKey) return PERSONAL_NAV_ITEMS.find((item) => item.key === personalKey)?.label ?? '';
  const key = resolveNavKey(pathname);
  return NAV_ITEMS.find((item) => item.key === key)?.label ?? '';
}

/** 依目前路徑決定側邊選單要高亮哪一項；不屬於任何一級頁面時回傳 null。 */
export function resolveNavKey(pathname: string): NavKey | null {
  if (pathname === '/') return 'workbench';
  const hit = NAV_ITEMS.find((item) => item.href !== '/' && matches(pathname, item.href));
  return hit?.key ?? null;
}
