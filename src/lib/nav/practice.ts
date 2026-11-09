import type { NavRegistration } from './shared';

// 執業主體與審核台（MIL-109）：依目前身分才出現的入口，不放進 admin 選單（它是所有身分共用的項目）。
// 執業主體組織看得到「執業主體」，平台營運者看得到「審核台」。身分由殼層讀 /api/auth/identities 決定。
export const PRACTICE_HREF = '/practice';
export const DESK_HREF = '/desk';

export const practiceNav = {
  identity: [
    { key: 'practice', label: '執業主體', href: PRACTICE_HREF, identity: 'practice' },
    { key: 'desk', label: '審核台', href: DESK_HREF, identity: 'operator' },
  ],
} as const satisfies NavRegistration;
