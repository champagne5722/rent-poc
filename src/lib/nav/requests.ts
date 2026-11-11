import type { NavRegistration } from './shared';

// 申請（MIL-206）：委託管理申請與住宅包租申請。業者在這裡產生連結，屋主在這裡確認與送出。
// 業者與屋主共用同一個路徑，頁面依組織的種類顯示各自的內容。
export const REQUESTS_HREF = '/requests';

export const requestsNav = {
  admin: [{ key: 'requests', label: '申請', href: REQUESTS_HREF }],
} as const satisfies NavRegistration;
