import type { NavRegistration } from './shared';

export const paymentAccountsNav = {
  admin: [
    // 收款帳戶（MIL-118）：登錄收款帳戶與持有人，只存遮罩識別
    { key: 'payment-accounts', label: '收款帳戶', href: '/payment-accounts' },
  ],
} as const satisfies NavRegistration;
