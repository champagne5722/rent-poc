import type { RequestContext } from './request-context';

// 屋主端的身分（MIL-94「屋主端殼層」）。MIL-103 起來自登入的 requestContext()，讀取入口在 current-owner-session.ts。
// 這裡只放純資料與純轉換，讓規則可以直接測。SEED_OWNERS 是總覽假資料 adapter（MIL-96）用的虛構屋主。

export type OwnerSession = {
  partyId: string;
  ownerOrgId: string;
  displayName: string;
};

// 假資料，人名與 ID 都是虛構的。MIL-96 的總覽假資料以這兩位屋主為準。
export const SEED_OWNERS: readonly OwnerSession[] = [
  { partyId: 'party-owner-demo-1', ownerOrgId: 'org-owner-demo-1', displayName: '王美玲' },
  { partyId: 'party-owner-demo-2', ownerOrgId: 'org-owner-demo-2', displayName: '陳志明' },
];

/**
 * 登入脈絡轉屋主身分（MIL-103）。只有 org 脈絡、組織種類是 owner 時才有屋主身分，其他一律 null：
 * 經理人（practice）、承租人（party）、平台營運者（operator）都不是屋主端的使用者。
 */
export function ownerSessionFromContext(rc: RequestContext, displayName: string): OwnerSession | null {
  if (rc.kind !== 'org' || rc.orgKind !== 'owner') return null;
  return { partyId: rc.partyId, ownerOrgId: rc.orgId, displayName };
}
