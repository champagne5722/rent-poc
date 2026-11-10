// 案件種類（ADR-0030 決議 1 到 4，MIL-195）。純函式，沒有 I/O。
//
// 用詞改了，讀程式碼與舊註解時照下表換讀（ADR-0030 決議 2）：
//
//   案件種類        資料上的值       資料上的組合（過渡期，舊欄位仍在）
//   租賃案件        lease            kind = lease，業務類型 self_managed 或 managed
//   委託管理案件    management       kind = management
//   包租案件        master_lease     kind = lease，業務類型 self_managed，承租人是包租業者
//   轉租案件        sublease         kind = lease，業務類型 master_lease
//
// 注意兩個 master_lease 不同義：
// - 案件種類 `master_lease` 是新的包租案件，指屋主租給包租業者的那一份（住宅包租契約）。
// - 業務類型 `master_lease` 是舊值，指包租業者轉租給承租人的那一份，現在叫轉租案件（住宅轉租契約）。
// 舊值留給既有的呼叫端讀取，由 MIL-197、MIL-198 逐批搬到案件種類，MIL-203 才移除。
// 新程式碼判斷「是不是包租或轉租」一律看案件種類，不要看業務類型。

import type { BusinessType, CaseKind } from './transitions';

/** 案件種類，對應四份法定契約：住宅租賃、委託管理、住宅包租、住宅轉租。與 `org.cases.case_kind` 一致。 */
export const STATUTORY_CASE_KINDS = ['lease', 'management', 'master_lease', 'sublease'] as const;
export type StatutoryCaseKind = (typeof STATUTORY_CASE_KINDS)[number];

export function isStatutoryCaseKind(value: unknown): value is StatutoryCaseKind {
  return typeof value === 'string' && (STATUTORY_CASE_KINDS as readonly string[]).includes(value);
}

/** 組織種類：屋主組織、執業主體組織（與 creation.ts 的 OrgKind 相同）。 */
type HostOrgKind = 'owner' | 'practice';

/**
 * 各種案件允許的主辦組織（ADR-0030 決議 1）。
 * 租賃案件：屋主組織辦自管，代管業者辦代管。其餘三種只有執業主體組織辦。
 */
export const HOST_ORG_KINDS_FOR_CASE_KIND: Record<StatutoryCaseKind, readonly HostOrgKind[]> = {
  lease: ['owner', 'practice'],
  management: ['practice'],
  master_lease: ['practice'],
  sublease: ['practice'],
};

/**
 * 由舊欄位推出案件種類，也就是 ADR-0030 決議 2 的對照表。migration 0077 的回填使用同一組規則，
 * 兩者由 case-kind-migration.test.ts 對照。
 *
 * @param lesseeIsMasterLessor 承租人是不是包租業者，來源是目前合約的 `fields.routing.lesseeIsMasterLessor`。
 *   只有自管租賃案件會用到。沒有合約的案件（例如後繼案件）傳 false。
 */
export function caseKindOf(input: {
  kind: CaseKind;
  businessType: BusinessType | null;
  lesseeIsMasterLessor: boolean;
}): StatutoryCaseKind {
  if (input.kind === 'management') return 'management';
  switch (input.businessType) {
    case 'master_lease':
      return 'sublease';
    case 'self_managed':
      return input.lesseeIsMasterLessor ? 'master_lease' : 'lease';
    case 'managed':
      return 'lease';
    case null:
      throw new Error('租賃案件必須有業務類型');
  }
}
