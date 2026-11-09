import { OWNER_ROOT_HREF, type NavRegistration } from './shared';

// 屋主端選單：只有資產總覽與移交，不放「建立合約」（P0-09 不允許屋主替代管案件擬約）
export const ownerOverviewNav = {
  owner: [{ key: 'overview', label: '資產總覽', href: OWNER_ROOT_HREF }],
} as const satisfies NavRegistration;
