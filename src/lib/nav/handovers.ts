import { OWNER_ROOT_HREF, type NavRegistration } from './shared';

export const handoversNav = {
  admin: [
    // 移交（MIL-94）：接收方看移交給我的案件與我交出的案件，經理人視角
    { key: 'handovers', label: '移交', href: '/handovers' },
  ],
  owner: [{ key: 'handovers', label: '移交', href: `${OWNER_ROOT_HREF}/handovers` }],
} as const satisfies NavRegistration;
