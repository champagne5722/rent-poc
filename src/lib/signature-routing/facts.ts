// 由合約的類型與欄位快照組出分流事實（ADR-0021 決議 1）。純函式，沒有 I/O。
//
// 規則表看案件種類（ADR-0030，MIL-197），但合約的欄位快照 `fields.routing` 仍存舊欄位：業務類型與「承租人是否為包租業者」。
// 這裡把快照換成案件種類，換法與 `caseKindOf`（遷移 0077 的回填規則）相同，所以案件與合約的案件種類一致。
// 案件的 `case_kind` 與快照在建立時一起寫入，MIL-203 移除舊欄位時，這裡改讀案件。

import { BUSINESS_TYPES, caseKindOf } from '../cases';
import { BUSINESS_TYPE_LABELS, type ContractType } from '../labels';
import type { ContractRoutingConditions } from '../types';
import type { CaseRoutingBasis, RoutingFacts } from './types';

/**
 * 失敗有兩種：
 * - `invalid_shape`：快照的形狀不對。存草稿時擋下。
 * - `undefined_combination`：快照的欄位互相矛盾，換不成任何案件種類，例如「代管且承租人是包租業者」。
 *   草稿可以先存，送簽與畫面的簽署序列會擋下。
 */
export type RoutingFactsResult =
  | { ok: true; facts: RoutingFacts }
  | { ok: false; code: 'invalid_shape' | 'undefined_combination'; reason: string };

/** 沒有分流條件的合約（含 MIL-66 之前建立的）視為自管租賃合約。 */
export const DEFAULT_ROUTING: ContractRoutingConditions = {
  businessType: 'self_managed',
  lesseeIsMasterLessor: false,
  brokerMediated: false,
};

function isRoutingConditions(value: unknown): value is ContractRoutingConditions {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.businessType === 'string' &&
    (BUSINESS_TYPES as readonly string[]).includes(v.businessType) &&
    typeof v.lesseeIsMasterLessor === 'boolean' &&
    typeof v.brokerMediated === 'boolean'
  );
}

/** 擋下畫面與送簽時給使用者看的條件說明：業務類型、承租人是否為包租業者、是否有經紀業者居間。 */
export function describeRoutingConditions(c: ContractRoutingConditions): string {
  const parts = [BUSINESS_TYPE_LABELS[c.businessType]];
  if (c.lesseeIsMasterLessor) parts.push('承租人是包租業者');
  if (c.brokerMediated) parts.push('有經紀業者居間');
  return parts.join('、');
}

/**
 * 快照換成案件部分。欄位互相矛盾回 null。
 * - 委託管理合約：快照的業務類型只能是代管（ADR-0018 決議 5）。
 * - 租賃合約：承租人是包租業者只能搭自管（包租案件）。轉租與代管不能搭承租人是包租業者。
 */
function caseBasisOf(contractType: ContractType, routing: ContractRoutingConditions | undefined): CaseRoutingBasis | null {
  if (contractType === 'management') {
    return routing === undefined || routing.businessType === 'managed' ? { caseKind: 'management' } : null;
  }
  const { businessType, lesseeIsMasterLessor } = routing ?? DEFAULT_ROUTING;
  if (lesseeIsMasterLessor && businessType !== 'self_managed') return null;
  const caseKind = caseKindOf({ kind: 'lease', businessType, lesseeIsMasterLessor });
  if (caseKind === 'lease') return { caseKind, businessType: businessType === 'managed' ? 'managed' : 'self_managed' };
  if (caseKind === 'master_lease' || caseKind === 'sublease') return { caseKind };
  return null;
}

/**
 * @param stored `fields.routing` 的原始值。undefined 代表沒有填，其他值形狀不對時回報錯誤，不退回預設值。
 * 委託管理合約沒有分流條件時是委託管理案件（委託管理合約只存在於代管，ADR-0018 決議 5）。
 */
export function routingFactsOf(contractType: ContractType, stored: unknown): RoutingFactsResult {
  if (stored !== undefined && !isRoutingConditions(stored)) {
    return { ok: false, code: 'invalid_shape', reason: '合約上的分流條件格式不正確' };
  }
  const basis = caseBasisOf(contractType, stored);
  if (!basis) {
    const conditions =
      contractType === 'management'
        ? `委託管理合約、${BUSINESS_TYPE_LABELS[stored!.businessType]}`
        : describeRoutingConditions(stored!);
    return { ok: false, code: 'undefined_combination', reason: `規則表沒有定義「${conditions}」這個組合` };
  }
  if (contractType === 'management') return { ok: true, facts: { documentType: 'management', ...basis } };
  const routing = stored ?? DEFAULT_ROUTING;
  return { ok: true, facts: { documentType: 'lease', brokerMediated: routing.brokerMediated, ...basis } };
}
