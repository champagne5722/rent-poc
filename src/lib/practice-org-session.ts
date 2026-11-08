// 後台的執業主體組織身分（MIL-98）。C 線完成登入前，比照 owner-session.ts 由環境變數挑一個 seed 假資料組織。
// 這裡只放純資料與純解析。讀 process.env 的入口在 current-practice-org-session.ts。

export type PracticeOrgSession = {
  orgId: string;
  name: string;
};

/** 指定要扮演哪一個 seed 組織。沒設定時用第一個，設成 none 時模擬不屬於任何執業主體。 */
export const PRACTICE_ORG_SESSION_ENV = 'PRACTICE_ORG_SESSION_ORG_ID';

const NO_ORG = 'none';

// 假資料，公司名與 ID 都是虛構的，與 src/lib/handover/demo-seed.ts 一致。
// 第一個是北辰：移交假資料裡它同時是接收方與交出方。
export const SEED_PRACTICE_ORGS: readonly PracticeOrgSession[] = [
  { orgId: 'org-pe-beichen', name: '北辰租賃住宅管理股份有限公司' },
  { orgId: 'org-pe-suilin', name: '穗林物業管理顧問有限公司' },
  { orgId: 'org-pe-yaoshi', name: '曜石不動產管理有限公司' },
];

export function resolvePracticeOrgSession(
  env: Readonly<Record<string, string | undefined>>,
): PracticeOrgSession | null {
  const requested = env[PRACTICE_ORG_SESSION_ENV]?.trim();
  if (!requested) return SEED_PRACTICE_ORGS[0] ?? null;
  if (requested === NO_ORG) return null;
  return SEED_PRACTICE_ORGS.find((org) => org.orgId === requested) ?? null;
}
