import type { NavRegistration } from './shared';

// 我的證書（MIL-111）：執業主體組織的成員登錄自己的證書與任職。入口跟著身分出現，與「執業主體」分開放，
// 因為執業主體頁屬於組織，證書頁屬於成員本人。不併進 practice 的 identity 清單，以免改動既有身分入口的清單。
export const PRACTITIONER_HREF = '/practitioner';

export const practitionerNav = {
  personal: [{ key: 'practitioner', label: '我的證書', href: PRACTITIONER_HREF, identity: 'practice' }],
} as const satisfies NavRegistration;
