// 帳務、押金與權限規則的分類（ADR-0030 決議 2、3，MIL-198）。純函式，沒有 I/O。
//
// 這些規則原本看業務類型（自管、代管、`master_lease`）。業務類型的 `master_lease` 是舊值，指轉租。
// 現在改看案件種類，規則的內容不變，只換判斷的依據：
//
//   案件種類        規則分類              沿用的原規則
//   租賃案件自管    lease_self_managed    業務類型 self_managed
//   租賃案件代管    lease_managed         業務類型 managed
//   包租案件        master_lease          業務類型 self_managed（待法務確認）
//   轉租案件        sublease              業務類型 master_lease（舊值，指轉租）
//   委託管理案件    management            委託管理案件的規則
//
// 租賃案件的自管與代管規則不同，所以租賃案件再依業務類型分兩種。其他三種案件沒有業務類型。
// 包租案件在資料上是自管租賃（業務類型 self_managed），原本就走自管的規則，沿用的假設待法務確認。

import type { BusinessType } from './transitions';
import type { StatutoryCaseKind } from './case-kind';

export const CASE_RULE_VARIANTS = ['lease_self_managed', 'lease_managed', 'master_lease', 'sublease', 'management'] as const;
export type CaseRuleVariant = (typeof CASE_RULE_VARIANTS)[number];

/** 租賃案件的業務類型：自管或代管。其他三種案件沒有業務類型。 */
export type LeaseBusinessType = Extract<BusinessType, 'self_managed' | 'managed'>;

/** 判斷規則分類需要的案件事實。 */
export interface CaseRuleFacts {
  caseKind: StatutoryCaseKind;
  /** 只有租賃案件需要。其他案件種類忽略這個欄位。 */
  businessType: BusinessType | null;
}

/**
 * 由案件種類（租賃案件再加業務類型）推出規則分類。
 * 租賃案件沒有業務類型，或業務類型不是自管與代管時丟 RangeError：資料不一致時不猜，也不放行。
 */
export function caseRuleVariantOf(facts: CaseRuleFacts): CaseRuleVariant {
  switch (facts.caseKind) {
    case 'management':
      return 'management';
    case 'master_lease':
      return 'master_lease';
    case 'sublease':
      return 'sublease';
    case 'lease':
      if (facts.businessType === 'self_managed') return 'lease_self_managed';
      if (facts.businessType === 'managed') return 'lease_managed';
      throw new RangeError(`租賃案件的業務類型必須是自管或代管：${String(facts.businessType)}`);
    default:
      throw new RangeError(`不認得的案件種類：${String(facts.caseKind)}`);
  }
}

/**
 * 案件由管理業者經手：有管理人員簽章的點交證明與退還證明，社宅代管旗標適用，退租要等點交證明完成。
 * 租賃代管與轉租案件是。租賃自管與包租案件沿用自管的規則，不是（包租案件的沿用待法務確認）。
 */
export function isManagerOperated(variant: CaseRuleVariant): boolean {
  return variant === 'lease_managed' || variant === 'sublease';
}
