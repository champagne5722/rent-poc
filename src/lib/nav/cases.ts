import type { NavRegistration } from './shared';

export const casesNav = {
  admin: [
    // 案件（MIL-115）：建約先建案件，清單列出全部案件與狀態
    { key: 'cases', label: '案件', href: '/cases' },
  ],
} as const satisfies NavRegistration;
