// 屋主端的身分（MIL-94「屋主端殼層」）。C 線完成登入前，身分由環境變數挑一位 seed 假資料屋主。
// 這裡只放純資料與純解析，讓規則可以直接測。讀 process.env 的入口在 current-owner-session.ts。

export type OwnerSession = {
  partyId: string;
  ownerOrgId: string;
  displayName: string;
};

/** 指定要扮演哪一位 seed 屋主。沒設定時用第一位，設成 none 時模擬沒有屋主身分。 */
export const OWNER_SESSION_ENV = 'OWNER_SESSION_PARTY_ID';

const NO_OWNER = 'none';

// 假資料，人名與 ID 都是虛構的。MIL-96 的總覽假資料以這兩位屋主為準。
export const SEED_OWNERS: readonly OwnerSession[] = [
  { partyId: 'party-owner-demo-1', ownerOrgId: 'org-owner-demo-1', displayName: '王美玲' },
  { partyId: 'party-owner-demo-2', ownerOrgId: 'org-owner-demo-2', displayName: '陳志明' },
];

export function resolveOwnerSession(
  env: Readonly<Record<string, string | undefined>>,
): OwnerSession | null {
  const requestedPartyId = env[OWNER_SESSION_ENV]?.trim();
  if (!requestedPartyId) return SEED_OWNERS[0] ?? null;
  if (requestedPartyId === NO_OWNER) return null;
  return SEED_OWNERS.find((owner) => owner.partyId === requestedPartyId) ?? null;
}
