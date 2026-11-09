import type { NavRegistration } from './shared';

export const propertiesNav = {
  admin: [{ key: 'properties', label: '物件', href: '/properties' }],
} as const satisfies NavRegistration;
