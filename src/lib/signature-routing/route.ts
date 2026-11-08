// routeSignatures（ADR-0018 決議 3）：純函式，沒有 I/O。
// 規則表沒有的組合一律回傳拒絕，不給預設序列。

import { BUSINESS_TYPES } from '../cases';
import {
  BROKER_APPEND_RULE,
  DEFAULT_VERIFY_METHODS,
  SEQUENCE_RULES,
  SIGNATURE_RULES_VERSION,
  type SeatTemplate,
  type SequenceRule,
} from './rules';
import { DOCUMENT_TYPES, type PlannedSeat, type RoutingFacts, type SignatureRoute } from './types';

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
  if (!when.businessTypes.includes(facts.businessType)) return false;
  if (when.lesseeIsMasterLessor === undefined) return true;
  return facts.documentType === 'lease' && facts.lesseeIsMasterLessor === when.lesseeIsMasterLessor;
}

export function routeSignatures(facts: RoutingFacts): SignatureRoute {
  if (!facts || typeof facts !== 'object') return reject('invalid_facts', '分流事實不是物件');
  if (!(DOCUMENT_TYPES as readonly string[]).includes(facts.documentType)) {
    return reject('unknown_document_type', `不認得的文件類型：${String(facts.documentType)}`);
  }
  if (!(BUSINESS_TYPES as readonly string[]).includes(facts.businessType)) {
    return reject('unknown_business_type', `不認得的業務類型：${String(facts.businessType)}`);
  }
  if (facts.documentType === 'lease') {
    if (typeof facts.lesseeIsMasterLessor !== 'boolean' || typeof facts.brokerMediated !== 'boolean') {
      return reject('invalid_facts', '租賃合約必須明確提供「承租人是否為包租業者」與「是否有經紀業者居間」');
    }
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
  const parts: string[] = [`文件類型 ${facts.documentType}`, `業務類型 ${facts.businessType}`];
  if (facts.documentType === 'lease') {
    parts.push(`承租人是包租業者 ${facts.lesseeIsMasterLessor}`, `經紀居間 ${facts.brokerMediated}`);
  }
  return parts.join('，');
}
