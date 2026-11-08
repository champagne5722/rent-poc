import { describe, expect, it } from 'vitest';
import { routeSignatures, SIGNATURE_RULES_VERSION, type RoutingFacts, type SignatureRoute } from './index';

// 全矩陣表格測試：ADR-0018 決議 5 的 13 列，加上未定義組合必須拒絕。
// 預期值手寫自 ADR 表格，不由規則表衍生。

const lease = (
  businessType: 'self_managed' | 'managed' | 'master_lease',
  extra: { lesseeIsMasterLessor?: boolean; brokerMediated?: boolean } = {},
): RoutingFacts => ({
  documentType: 'lease',
  businessType,
  lesseeIsMasterLessor: extra.lesseeIsMasterLessor ?? false,
  brokerMediated: extra.brokerMediated ?? false,
});

const rolesOf = (route: SignatureRoute) => {
  if (route.kind !== 'sequence') throw new Error(`預期有簽署序列，實際是 ${route.kind}`);
  return route.plan.seats.map((s) => s.role);
};

const sequenceRows: [string, RoutingFacts, string[]][] = [
  ['1 委託管理合約，代管', { documentType: 'management', businessType: 'managed' }, ['party_a', 'practitioner', 'party_b']],
  ['2 租賃合約，自管', lease('self_managed'), ['party_b', 'party_a']],
  ['3 租賃合約，代管', lease('managed'), ['party_b', 'party_a']],
  ['4 租賃合約，包租', lease('master_lease'), ['party_b', 'practitioner', 'party_a']],
  [
    '5 租賃合約，自管且承租人是包租業者',
    lease('self_managed', { lesseeIsMasterLessor: true }),
    ['party_a', 'practitioner', 'party_b'],
  ],
  ['6 租賃合約自管，有經紀業者居間', lease('self_managed', { brokerMediated: true }), ['party_b', 'party_a', 'practitioner']],
  ['6 租賃合約代管，有經紀業者居間', lease('managed', { brokerMediated: true }), ['party_b', 'party_a', 'practitioner']],
  [
    '6 租賃合約包租，有經紀業者居間（四位）',
    lease('master_lease', { brokerMediated: true }),
    ['party_b', 'practitioner', 'party_a', 'practitioner'],
  ],
  [
    '6 租賃合約自管且承租人是包租業者，有經紀業者居間（四位）',
    lease('self_managed', { lesseeIsMasterLessor: true, brokerMediated: true }),
    ['party_a', 'practitioner', 'party_b', 'practitioner'],
  ],
  ['8 點交證明，代管', { documentType: 'handover_certificate', businessType: 'managed' }, ['party_b', 'party_a', 'practitioner']],
  ['9 點交證明，包租', { documentType: 'handover_certificate', businessType: 'master_lease' }, ['party_b', 'practitioner', 'party_a']],
  ['10 押金結算單，自管', { documentType: 'deposit_settlement', businessType: 'self_managed' }, ['party_b', 'party_a']],
  ['10 押金結算單，代管', { documentType: 'deposit_settlement', businessType: 'managed' }, ['party_b', 'party_a']],
  ['10 押金結算單，包租', { documentType: 'deposit_settlement', businessType: 'master_lease' }, ['party_b', 'party_a']],
  ['11 退還證明，自管', { documentType: 'deposit_refund_certificate', businessType: 'self_managed' }, ['party_b', 'party_a']],
  ['12 退還證明，代管', { documentType: 'deposit_refund_certificate', businessType: 'managed' }, ['party_b', 'party_a', 'practitioner']],
  ['13 退還證明，包租', { documentType: 'deposit_refund_certificate', businessType: 'master_lease' }, ['party_b', 'practitioner', 'party_a']],
];

describe('routeSignatures：規則表的簽署序列', () => {
  it.each(sequenceRows)('%s', (_name, facts, expected) => {
    expect(rolesOf(routeSignatures(facts))).toEqual(expected);
  });

  it('點交證明，自管：不送簽，由雙方確認', () => {
    const route = routeSignatures({ documentType: 'handover_certificate', businessType: 'self_managed' });
    expect(route).toMatchObject({ kind: 'not_required', ruleId: 'handover_certificate.self_managed' });
  });
});

const undefinedCombinations: [string, RoutingFacts][] = [
  ['委託管理合約，自管', { documentType: 'management', businessType: 'self_managed' }],
  ['委託管理合約，包租', { documentType: 'management', businessType: 'master_lease' }],
  ['租賃合約，代管且承租人是包租業者', lease('managed', { lesseeIsMasterLessor: true })],
  ['租賃合約，包租且承租人是包租業者', lease('master_lease', { lesseeIsMasterLessor: true })],
];

describe('routeSignatures：未定義的組合', () => {
  it.each(undefinedCombinations)('%s 回傳拒絕，不給預設序列', (_name, facts) => {
    const route = routeSignatures(facts);
    expect(route.kind).toBe('rejected');
    expect(route).not.toHaveProperty('plan');
  });

  it('不認得的文件類型回傳拒絕', () => {
    const facts = { documentType: 'receipt', businessType: 'managed' } as unknown as RoutingFacts;
    expect(routeSignatures(facts).kind).toBe('rejected');
  });

  it('不認得的業務類型回傳拒絕', () => {
    const facts = { documentType: 'deposit_settlement', businessType: 'sublease' } as unknown as RoutingFacts;
    expect(routeSignatures(facts).kind).toBe('rejected');
  });

  it('租賃合約缺少分流旗標時回傳拒絕，不當作 false', () => {
    const facts = { documentType: 'lease', businessType: 'self_managed' } as unknown as RoutingFacts;
    expect(routeSignatures(facts).kind).toBe('rejected');
  });
});

describe('routeSignatures：每個席位的欄位', () => {
  it('包租租賃合約：乙方、執業人員、甲方各有角色、依據、rule_id、驗證方式與簽署區域頁', () => {
    const route = routeSignatures(lease('master_lease'));
    if (route.kind !== 'sequence') throw new Error('預期有簽署序列');
    expect(route.plan.ruleVersion).toBe(SIGNATURE_RULES_VERSION);
    expect(route.plan.seats).toEqual([
      {
        ruleId: 'lease.master_lease.party_b',
        role: 'party_b',
        statuteRef: '§32 第 2、3 款',
        verifyMethods: ['email'],
        requiredFieldPages: ['body'],
      },
      {
        ruleId: 'lease.master_lease.practitioner',
        role: 'practitioner',
        statuteRef: '§32 第 2、3 款',
        verifyMethods: ['email'],
        requiredFieldPages: ['body', 'status_annex'],
        practitioner: { certificateKinds: ['rental_housing_manager'], fullTime: true, entitySource: 'party_a' },
      },
      {
        ruleId: 'lease.master_lease.party_a',
        role: 'party_a',
        statuteRef: '§32 第 2、3 款',
        verifyMethods: ['email'],
        requiredFieldPages: ['body'],
      },
    ]);
  });

  it('居間加包租：兩位執業人員的 rule_id 不同，經紀人用經紀條例 §22 與經紀人證書', () => {
    const route = routeSignatures(lease('master_lease', { brokerMediated: true }));
    if (route.kind !== 'sequence') throw new Error('預期有簽署序列');
    const practitioners = route.plan.seats.filter((s) => s.role === 'practitioner');
    expect(practitioners.map((s) => s.ruleId)).toEqual(['lease.master_lease.practitioner', 'lease.broker']);
    expect(practitioners[1]).toMatchObject({
      statuteRef: '經紀條例 §22',
      practitioner: { certificateKinds: ['real_estate_broker'], fullTime: false, entitySource: 'broker_entity' },
    });
    expect(new Set(route.plan.seats.map((s) => s.ruleId)).size).toBe(4);
  });

  it('自管租賃合約維持現況：只有乙方與甲方，沒有執業人員資料', () => {
    const route = routeSignatures(lease('self_managed'));
    if (route.kind !== 'sequence') throw new Error('預期有簽署序列');
    expect(route.plan.seats.map((s) => [s.ruleId, s.role, s.verifyMethods])).toEqual([
      ['lease.self_managed.party_b', 'party_b', ['email']],
      ['lease.self_managed.party_a', 'party_a', ['email']],
    ]);
    expect(route.plan.seats.every((s) => !('practitioner' in s))).toBe(true);
  });

  it('所有可送簽的列，執業人員席位都帶證書種類、專任要求與執業主體來源', () => {
    for (const [, facts] of sequenceRows) {
      const route = routeSignatures(facts);
      if (route.kind !== 'sequence') continue;
      for (const seat of route.plan.seats) {
        expect(seat.statuteRef).toBeTruthy();
        expect(seat.verifyMethods).toEqual(['email']);
        expect(seat.requiredFieldPages.length).toBeGreaterThan(0);
        if (seat.role === 'practitioner') {
          expect(seat.practitioner?.certificateKinds.length).toBeGreaterThan(0);
          expect(seat.practitioner?.entitySource).toBeTruthy();
        } else {
          expect(seat.practitioner).toBeUndefined();
        }
      }
    }
  });

  it('經紀營業員證書不在任何席位的可簽章種類內', () => {
    for (const [, facts] of sequenceRows) {
      const route = routeSignatures(facts);
      if (route.kind !== 'sequence') continue;
      for (const seat of route.plan.seats) {
        expect(seat.practitioner?.certificateKinds ?? []).not.toContain('real_estate_sales_agent');
      }
    }
  });
});
