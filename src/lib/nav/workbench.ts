import type { NavRegistration } from './shared';

export const workbenchNav = {
  admin: [
    // 工作台是登入後的預設落地頁，/ 直接渲染工作台（規格 §5）
    { key: 'workbench', label: '工作台', href: '/' },
  ],
} as const satisfies NavRegistration;
