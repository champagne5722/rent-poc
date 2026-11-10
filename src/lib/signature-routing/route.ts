// routeSignatures（ADR-0018 決議 3）：純函式，沒有 I/O。
// 規則表沒有的組合一律回傳拒絕，不給預設序列。

import { isStatutoryCaseKind } from '../cases';
import {
  BROKER_APPEND_RULE,
  DEFAULT_VERIFY_METHODS,
  SEQUENCE_RULES,
  SIGNATURE_RULES_VERSION,
  type SeatTemplate,
  type SequenceRule,
} from './rules';
import { DOCUMENT_TYPES, LEASE_BUSINESS_TYPES, type PlannedSeat, type RoutingFacts, type SignatureRoute } from './types';

const reject = (code: Extract<SignatureRoute, { kind: 'rejected' }>['code'], reason: string): SignatureRoute => ({
  kind: 'rejected',
  code,
  reason,
});

function planSeat(ruleId: string, statuteRef: string, template: SeatTemplate): PlannedSeat {
  const seat: PlannedSeat = {
    ruleId,
    role: template.role,
    statuteRef: template.statuteRef ?? statuteRef,
    verifyMethods: DEFAULT_VERIFY_METHODS,
    requiredFieldPages: template.requiredFieldPages ?? ['body'],
  };
  if (template.practitioner) seat.practitioner = template.practitioner;
  return seat;
}

function matches(rule: SequenceRule, facts: RoutingFacts): boolean {
  const { when } = rule;
  if (when.documentType !== facts.documentType) return false;
  if (!when.caseKinds.includes(facts.caseKind)) return false;
  // 業務類型只限縮租賃案件的自管與代管。其他案件種類沒有業務類型
  if (facts.caseKind !== 'lease' || when.businessType === undefined) return true;
  return facts.businessType === when.businessType;
}

export function routeSignatures(facts: RoutingFacts): SignatureRoute {
  if (!facts || typeof facts !== 'object') return reject('invalid_facts', '分流事實不是物件');
  if (!(DOCUMENT_TYPES as readonly string[]).includes(facts.documentType)) {
    return reject('unknown_document_type', `不認得的文件類型：${String(facts.documentType)}`);
  }
  if (!isStatutoryCaseKind(facts.caseKind)) {
    return reject('unknown_case_kind', `不認得的案件種類：${String(facts.caseKind)}`);
  }
  // 租賃案件的業務類型只有自管與代管。舊值 master_lease 是轉租，不是租賃案件的業務類型
  if (facts.caseKind === 'lease' && !(LEASE_BUSINESS_TYPES as readonly string[]).includes(facts.businessType)) {
    return reject('unknown_business_type', `不認得的業務類型：${String(facts.businessType)}`);
  }
  if (facts.documentType === 'lease' && typeof facts.brokerMediated !== 'boolean') {
    return reject('invalid_facts', '租賃合約必須明確提供「是否有經紀業者居間」');
  }

  const rule = SEQUENCE_RULES.find((r) => matches(r, facts));
  if (!rule) {
    return reject('undefined_combination', `規則表沒有定義這個組合：${describe(facts)}`);
  }

  if (rule.seats === null) {
    return { kind: 'not_required', ruleVersion: SIGNATURE_RULES_VERSION, ruleId: rule.id, statuteRef: rule.statuteRef };
  }

  const seats = rule.seats.map((t) => planSeat(`${rule.id}.${t.seatName ?? t.role}`, rule.statuteRef, t));
  if (facts.documentType === 'lease' && facts.brokerMediated) {
    seats.push(planSeat(BROKER_APPEND_RULE.id, BROKER_APPEND_RULE.statuteRef, BROKER_APPEND_RULE.seat));
  }
  return { kind: 'sequence', plan: { ruleVersion: SIGNATURE_RULES_VERSION, baseRuleId: rule.id, seats } };
}

function describe(facts: RoutingFacts): string {
  const parts: string[] = [`文件類型 ${facts.documentType}`, `案件種類 ${facts.caseKind}`];
  if (facts.caseKind === 'lease') parts.push(`業務類型 ${facts.businessType}`);
  if (facts.documentType === 'lease') parts.push(`經紀居間 ${facts.brokerMediated}`);
  return parts.join('，');
}
