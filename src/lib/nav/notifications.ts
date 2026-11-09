import type { NavRegistration } from './shared';

export const notificationsNav = {
  admin: [
    // 通知（MIL-120）：站內通知清單，選單項帶未讀數
    { key: 'notifications', label: '通知', href: '/notifications' },
  ],
} as const satisfies NavRegistration;
