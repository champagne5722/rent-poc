import type { NavRegistration } from './shared';

export const contractsNav = {
  admin: [{ key: 'contracts', label: '合約', href: '/contracts' }],
} as const satisfies NavRegistration;
