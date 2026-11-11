import type { NavRegistration } from './shared';

// 成員管理（MIL-106、MIL-185）：頁面屬於組織，守門規則在頁面本身（loadMemberPage）：
// 組織身分才有成員清單。所以入口只給屋主與執業主體這兩種組織身分，個人與平台營運者身分不顯示。
// 頁面另檢查 org_member.read 權限，入口不放寬、不取代頁面的守門。
export const MEMBERS_NAV_HREF = '/settings/members';

export const membersNav = {
  identity: [{ key: 'members', label: '成員管理', href: MEMBERS_NAV_HREF, identity: ['owner', 'practice'] }],
} as const satisfies NavRegistration;
