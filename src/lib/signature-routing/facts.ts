// 由合約的類型與欄位快照組出分流事實（ADR-0021 決議 1）。純函式，沒有 I/O。

import { BUSINESS_TYPES } from '../cases';
import type { ContractType } from '../labels';
import type { ContractRoutingConditions } from '../types';
import type { RoutingFacts } from './types';

export type RoutingFactsResult = { ok: true; facts: RoutingFacts } | { ok: false; reason: string };

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

/**
 * @param stored `fields.routing` 的原始值。undefined 代表沒有填，其他值形狀不對時回報錯誤，不退回預設值。
 * 委託管理合約沒有分流條件時，業務類型是代管（委託管理合約只存在於代管，ADR-0018 決議 5）。
 */
export function routingFactsOf(contractType: ContractType, stored: unknown): RoutingFactsResult {
  if (stored !== undefined && !isRoutingConditions(stored)) {
    return { ok: false, reason: '合約上的分流條件格式不正確' };
  }
  if (contractType === 'management') {
    return { ok: true, facts: { documentType: 'management', businessType: stored?.businessType ?? 'managed' } };
  }
  const routing = stored ?? DEFAULT_ROUTING;
  return {
    ok: true,
    facts: {
      documentType: 'lease',
      businessType: routing.businessType,
      lesseeIsMasterLessor: routing.lesseeIsMasterLessor,
      brokerMediated: routing.brokerMediated,
    },
  };
}
