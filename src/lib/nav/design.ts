import type { NavRegistration } from './shared';

export const designNav = {
  admin: [
    // 設計樣式頁：呈現 DESIGN.md 目前的 token 與元件樣式，供調整佈局與字級時對照
    { key: 'design', label: '設計', href: '/design' },
  ],
} as const satisfies NavRegistration;
