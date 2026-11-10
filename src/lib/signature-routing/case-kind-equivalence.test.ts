import { describe, expect, it } from 'vitest';
import type { ContractType } from '../labels';
import type { ContractRoutingConditions } from '../types';
import {
  findSeatRule,
  routeSignatures,
  routingFactsOf,
  SIGNATURE_RULES_VERSION,
  SUPPORTED_RULE_VERSIONS,
  type RoutingFacts,
  type SignatureRoute,
} from './index';

// MIL-197：簽章分流的條件由「業務類型加承租人是否為包租業者」改成案件種類（ADR-0030 決議 2、3）。
// 這份測試逐列比對改名前後：左邊是版本 1 的條件，右邊是版本 2 的案件種類，兩邊的席位 rule_id 與順序必須相同。
// 「改名前」的預期值手寫自版本 1 的規則表，不由目前的規則表衍生。

/** 舊的分流條件：版本 1 的規則表看這三個旗標。 */
type LegacyConditions = ContractRoutingConditions;

const legacy = (
  businessType: LegacyConditions['businessType'],
  lesseeIsMasterLessor = false,
  brokerMediated = false,
): LegacyConditions => ({ businessType, lesseeIsMasterLessor, brokerMediated });

const idsOf = (route: SignatureRoute): string[] => {
  if (route.kind !== 'sequence') throw new Error(`預期有簽署序列，實際是 ${route.kind}`);
  return route.plan.seats.map((s) => s.ruleId);
};

/** 走真實的路徑：合約的 fields.routing 快照，經 routingFactsOf 換成案件種類，再分流。 */
function routeOfSnapshot(contractType: ContractType, stored: unknown): SignatureRoute {
  const resolved = routingFactsOf(contractType, stored);
  if (!resolved.ok) throw new Error(`預期分流事實可組出，實際是 ${resolved.code}：${resolved.reason}`);
  return routeSignatures(resolved.facts);
}

describe('合約：四種案件，改名前後的簽署序列相同', () => {
  const rows: [string, string, LegacyConditions, string[]][] = [
    [
      '租賃案件，自管',
      'lease',
      legacy('self_managed'),
      ['lease.self_managed.party_b', 'lease.self_managed.party_a'],
    ],
    ['租賃案件，代管', 'lease', legacy('managed'), ['lease.managed.party_b', 'lease.managed.party_a']],
    [
      '轉租案件（舊業務類型 master_lease）',
      'sublease',
      legacy('master_lease'),
      ['lease.master_lease.party_b', 'lease.master_lease.practitioner', 'lease.master_lease.party_a'],
    ],
    [
      '包租案件（自管，承租人是包租業者）',
      'master_lease',
      legacy('self_managed', true),
      [
        'lease.self_managed_lessee_master_lessor.party_a',
        'lease.self_managed_lessee_master_lessor.practitioner',
        'lease.self_managed_lessee_master_lessor.party_b',
      ],
    ],
  ];

  it.each(rows)('%s', (_name, expectedCaseKind, conditions, expectedIds) => {
    const resolved = routingFactsOf('lease', conditions);
    if (!resolved.ok) throw new Error(resolved.reason);
    expect(resolved.facts.caseKind).toBe(expectedCaseKind);
    expect(idsOf(routeSignatures(resolved.facts))).toEqual(expectedIds);
  });

  it.each(rows)('%s：有經紀業者居間時，序列之後加經紀人席位', (_name, _kind, conditions, expectedIds) => {
    const withBroker = { ...conditions, brokerMediated: true };
    expect(idsOf(routeOfSnapshot('lease', withBroker))).toEqual([...expectedIds, 'lease.broker']);
  });

  it('委託管理案件', () => {
    expect(idsOf(routeOfSnapshot('management', undefined))).toEqual([
      'management.managed.party_a',
      'management.managed.practitioner',
      'management.managed.party_b',
    ]);
    expect(idsOf(routeOfSnapshot('management', legacy('managed')))).toEqual([
      'management.managed.party_a',
      'management.managed.practitioner',
      'management.managed.party_b',
    ]);
  });

  it('沒有分流條件的既有租賃合約視為租賃案件自管', () => {
    expect(idsOf(routeOfSnapshot('lease', undefined))).toEqual(['lease.self_managed.party_b', 'lease.self_managed.party_a']);
  });

  it('轉租案件的執業人員席位仍要求現況確認附件頁，其他案件不要求', () => {
    const annexSeats = (conditions: LegacyConditions) => {
      const route = routeOfSnapshot('lease', conditions);
      if (route.kind !== 'sequence') throw new Error('預期有簽署序列');
      return route.plan.seats.filter((s) => s.requiredFieldPages.includes('status_annex')).map((s) => s.ruleId);
    };
    expect(annexSeats(legacy('master_lease'))).toEqual(['lease.master_lease.practitioner']);
    expect(annexSeats(legacy('self_managed', true))).toEqual([]);
    expect(annexSeats(legacy('self_managed'))).toEqual([]);
    expect(annexSeats(legacy('managed'))).toEqual([]);
  });
});

describe('點交證明、押金結算單與退還證明：四種案件，改名前後的簽署序列相同', () => {
  // 版本 1 的 E 線事實只帶業務類型。包租案件（承租人是包租業者）當時帶自管，所以沿用自管那一列。
  type DocumentRow = [string, RoutingFacts, string[] | 'not_required'];

  const handover: DocumentRow[] = [
    ['點交證明，租賃案件自管', { documentType: 'handover_certificate', caseKind: 'lease', businessType: 'self_managed' }, 'not_required'],
    [
      '點交證明，租賃案件代管',
      { documentType: 'handover_certificate', caseKind: 'lease', businessType: 'managed' },
      ['handover_certificate.managed.party_b', 'handover_certificate.managed.party_a', 'handover_certificate.managed.practitioner'],
    ],
    [
      '點交證明，轉租案件',
      { documentType: 'handover_certificate', caseKind: 'sublease' },
      [
        'handover_certificate.master_lease.party_b',
        'handover_certificate.master_lease.practitioner',
        'handover_certificate.master_lease.party_a',
      ],
    ],
    ['點交證明，包租案件', { documentType: 'handover_certificate', caseKind: 'master_lease' }, 'not_required'],
  ];

  const settlement: DocumentRow[] = [
    ['押金結算單，租賃案件自管', { documentType: 'deposit_settlement', caseKind: 'lease', businessType: 'self_managed' }, ['deposit_settlement.all.party_b', 'deposit_settlement.all.party_a']],
    ['押金結算單，租賃案件代管', { documentType: 'deposit_settlement', caseKind: 'lease', businessType: 'managed' }, ['deposit_settlement.all.party_b', 'deposit_settlement.all.party_a']],
    ['押金結算單，轉租案件', { documentType: 'deposit_settlement', caseKind: 'sublease' }, ['deposit_settlement.all.party_b', 'deposit_settlement.all.party_a']],
    ['押金結算單，包租案件', { documentType: 'deposit_settlement', caseKind: 'master_lease' }, ['deposit_settlement.all.party_b', 'deposit_settlement.all.party_a']],
  ];

  const refund: DocumentRow[] = [
    [
      '退還證明，租賃案件自管',
      { documentType: 'deposit_refund_certificate', caseKind: 'lease', businessType: 'self_managed' },
      ['deposit_refund_certificate.self_managed.party_b', 'deposit_refund_certificate.self_managed.party_a'],
    ],
    [
      '退還證明，租賃案件代管',
      { documentType: 'deposit_refund_certificate', caseKind: 'lease', businessType: 'managed' },
      [
        'deposit_refund_certificate.managed.party_b',
        'deposit_refund_certificate.managed.party_a',
        'deposit_refund_certificate.managed.practitioner',
      ],
    ],
    [
      '退還證明，轉租案件',
      { documentType: 'deposit_refund_certificate', caseKind: 'sublease' },
      [
        'deposit_refund_certificate.master_lease.party_b',
        'deposit_refund_certificate.master_lease.practitioner',
        'deposit_refund_certificate.master_lease.party_a',
      ],
    ],
    [
      '退還證明，包租案件',
      { documentType: 'deposit_refund_certificate', caseKind: 'master_lease' },
      ['deposit_refund_certificate.self_managed.party_b', 'deposit_refund_certificate.self_managed.party_a'],
    ],
  ];

  it.each([...handover, ...settlement, ...refund])('%s', (_name, facts, expected) => {
    const route = routeSignatures(facts);
    if (expected === 'not_required') {
      expect(route).toMatchObject({ kind: 'not_required', ruleId: 'handover_certificate.self_managed' });
    } else {
      expect(idsOf(route)).toEqual(expected);
    }
  });

  it('委託管理案件沒有點交證明、押金結算單與退還證明', () => {
    for (const documentType of ['handover_certificate', 'deposit_settlement', 'deposit_refund_certificate'] as const) {
      expect(routeSignatures({ documentType, caseKind: 'management' }).kind).toBe('rejected');
    }
  });
});

describe('分流事實由合約快照換成案件種類', () => {
  it('租賃合約：快照的業務類型與承租人旗標換成案件種類', () => {
    const kindOf = (conditions: LegacyConditions) => {
      const resolved = routingFactsOf('lease', conditions);
      return resolved.ok ? resolved.facts : resolved.code;
    };
    expect(kindOf(legacy('self_managed'))).toEqual({ documentType: 'lease', caseKind: 'lease', businessType: 'self_managed', brokerMediated: false });
    expect(kindOf(legacy('managed', false, true))).toEqual({ documentType: 'lease', caseKind: 'lease', businessType: 'managed', brokerMediated: true });
    expect(kindOf(legacy('master_lease'))).toEqual({ documentType: 'lease', caseKind: 'sublease', brokerMediated: false });
    expect(kindOf(legacy('self_managed', true))).toEqual({ documentType: 'lease', caseKind: 'master_lease', brokerMediated: false });
  });

  it('分流事實不再帶承租人是否為包租業者', () => {
    const resolved = routingFactsOf('lease', legacy('self_managed', true));
    expect(resolved.ok && 'lesseeIsMasterLessor' in resolved.facts).toBe(false);
  });

  it('互相矛盾的快照換不成案件種類，回報未定義的組合，不給預設序列', () => {
    const contradictions: [string, ContractType, LegacyConditions][] = [
      ['代管且承租人是包租業者', 'lease', legacy('managed', true)],
      ['轉租且承租人是包租業者', 'lease', legacy('master_lease', true)],
      ['委託管理合約，自管', 'management', legacy('self_managed')],
      ['委託管理合約，轉租', 'management', legacy('master_lease')],
    ];
    for (const [, contractType, conditions] of contradictions) {
      const resolved = routingFactsOf(contractType, conditions);
      expect(resolved).toMatchObject({ ok: false, code: 'undefined_combination' });
      if (!resolved.ok) expect(resolved.reason).toContain('規則表沒有定義');
    }
  });

  it('形狀不對的快照回報 invalid_shape', () => {
    expect(routingFactsOf('lease', { businessType: 'managed' })).toMatchObject({ ok: false, code: 'invalid_shape' });
  });
});

describe('版本 1 凍結的簽署序列在版本 2 仍然解析得到', () => {
  // 一份以版本 1 凍結的轉租案件序列：送簽時存下的 rule_id、rule_version 與席位順序。手寫，不由程式產生。
  const FROZEN_V1_SUBLEASE = [
    { ruleId: 'lease.master_lease.party_b', ruleVersion: 1, role: 'party_b' },
    { ruleId: 'lease.master_lease.practitioner', ruleVersion: 1, role: 'practitioner' },
    { ruleId: 'lease.master_lease.party_a', ruleVersion: 1, role: 'party_a' },
    { ruleId: 'lease.broker', ruleVersion: 1, role: 'practitioner' },
  ] as const;

  it('規則表版本升到 2，版本 1 與 2 都在支援範圍', () => {
    expect(SIGNATURE_RULES_VERSION).toBe(2);
    expect(SUPPORTED_RULE_VERSIONS).toEqual([1, 2]);
  });

  it('凍結序列的每個 rule_id 都找得回規則列與席位，角色與凍結時相同', () => {
    for (const frozen of FROZEN_V1_SUBLEASE) {
      const found = findSeatRule(frozen.ruleId, frozen.ruleVersion);
      expect(found, frozen.ruleId).not.toBeNull();
      expect(found?.role).toBe(frozen.role);
    }
  });

  it('凍結序列的席位順序與版本 2 重新分流的結果相同', () => {
    const route = routeOfSnapshot('lease', legacy('master_lease', false, true));
    expect(idsOf(route)).toEqual(FROZEN_V1_SUBLEASE.map((s) => s.ruleId));
    // 順序由規則列內的位置決定，凍結的 rule_id 找回的位置與凍結順序一致
    const indexes = FROZEN_V1_SUBLEASE.map((s) => findSeatRule(s.ruleId, 1)?.index);
    expect(indexes).toEqual([0, 1, 2, null]);
  });

  it('包租案件的凍結序列（舊稱承租人是包租業者）也解析得到', () => {
    const found = findSeatRule('lease.self_managed_lessee_master_lessor.practitioner', 1);
    expect(found).toMatchObject({ rowId: 'lease.self_managed_lessee_master_lessor', role: 'practitioner', index: 1 });
  });

  it('不認得的版本或 rule_id 回 null，不猜', () => {
    expect(findSeatRule('lease.master_lease.party_b', 3)).toBeNull();
    expect(findSeatRule('lease.master_lease.party_b', 0)).toBeNull();
    expect(findSeatRule('lease.sublease.party_b', 2)).toBeNull();
    expect(findSeatRule('lease.master_lease.broker', 1)).toBeNull();
  });

  it('版本 2 之後，新送簽的序列帶規則表版本 2', () => {
    const route = routeOfSnapshot('lease', legacy('master_lease'));
    expect(route.kind === 'sequence' && route.plan.ruleVersion).toBe(2);
  });
});
