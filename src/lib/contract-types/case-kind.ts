// 案件種類與合約類型的對應（MIL-199、ADR-0030 決議 6）。純函式，沒有 I/O，client 端也能引用。
//
// 四種案件各建自己的合約：
//
//   案件種類        合約類型        法定文件名
//   租賃案件        lease           住宅租賃契約
//   委託管理案件    management      委託管理租賃住宅契約書
//   包租案件        master_lease    住宅包租契約（屋主租給包租業者那一份）
//   轉租案件        sublease        住宅轉租契約（包租業者租給承租人那一份）
//
// 注意：舊業務類型（BusinessType）的 `master_lease` 指轉租，與這裡的 `master_lease` 相反。
// 建立合約的地方用 `contractTypeForCaseKind` 決定類型，不自己寫對應。

import type { StatutoryCaseKind } from '../cases/case-kind';
import type { ContractType } from '../labels';
import type { ContractRoutingConditions } from '../types';

/** 案件種類決定的合約類型。 */
export function contractTypeForCaseKind(caseKind: StatutoryCaseKind): ContractType {
  switch (caseKind) {
    case 'lease':
      return 'lease';
    case 'management':
      return 'management';
    case 'master_lease':
      return 'master_lease';
    case 'sublease':
      return 'sublease';
  }
}

/** 合約類型對應的案件種類。`contractTypeForCaseKind` 的反向。 */
export function caseKindForContractType(contractType: ContractType): StatutoryCaseKind {
  switch (contractType) {
    case 'lease':
      return 'lease';
    case 'management':
      return 'management';
    case 'master_lease':
      return 'master_lease';
    case 'sublease':
      return 'sublease';
  }
}

/**
 * 包租合約與轉租合約的分流條件快照（過渡）。快照仍存舊欄位，換成案件種類的規則與 `caseKindOf` 相同：
 * 包租案件是自管且承租人是包租業者，轉租案件是舊業務類型 master_lease。
 * 簽章分流看合約類型，不看這兩個欄位（facts.ts），這份快照給還在讀舊欄位的畫面與建案件用。MIL-203 移除。
 * 租賃合約與委託管理合約沒有對應的快照，回傳 undefined。
 */
export function routingSnapshotFor(
  contractType: ContractType,
  brokerMediated: boolean,
): ContractRoutingConditions | undefined {
  if (contractType === 'master_lease') {
    return { businessType: 'self_managed', lesseeIsMasterLessor: true, brokerMediated };
  }
  if (contractType === 'sublease') {
    return { businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated };
  }
  return undefined;
}
