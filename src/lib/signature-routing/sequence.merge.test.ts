import { describe, expect, it } from 'vitest';
import type { SignatureField } from '../types';
import { buildSignerSequence, fieldsOfSeat, findMergedSeats, seatSignerIndexes, type SeatAssignee, type SeatIdentity } from './sequence';
import { routeSignatures, type RoutingFacts, type SignaturePlan } from './index';

// 同一人兼任時合併成一位簽署人（ADR-0018 決議 9，MIL-76）。
// 判定條件：party_id 相同，且當事人簽署人屬於同一執業主體。

function planOf(facts: RoutingFacts): SignaturePlan {
  const route = routeSignatures(facts);
  if (route.kind !== 'sequence') throw new Error('預期有簽署序列');
  return route.plan;
}

/** 舊的分流條件換成案件種類（ADR-0030 決議 2）。 */
const lease = (businessType: 'self_managed' | 'managed' | 'master_lease', extra: { lesseeIsMasterLessor?: boolean; brokerMediated?: boolean } = {}): RoutingFacts => {
  const brokerMediated = extra.brokerMediated ?? false;
  if (businessType === 'master_lease') return { documentType: 'lease', caseKind: 'sublease', brokerMediated };
  if (extra.lesseeIsMasterLessor) return { documentType: 'lease', caseKind: 'master_lease', brokerMediated };
  return { documentType: 'lease', caseKind: 'lease', businessType, brokerMediated };
};

const field = (id: string, signer: SignatureField['signer'], slot?: string): SignatureField => ({
  id,
  signer,
  page: 0,
  x: 0.1,
  y: 0.8,
  w: 0.2,
  h: 0.1,
  ...(slot ? { slot } : {}),
});

const CHEN: SeatIdentity = { partyId: 'party-chen', entityId: 'org-a' };
const WANG: SeatIdentity = { partyId: 'party-wang', entityId: 'org-a' };

const person = (name: string, identity?: SeatIdentity): SeatAssignee => ({
  name,
  email: `${name}@example.com`,
  ...(identity ? { identity } : {}),
});

interface MergeCase {
  title: string;
  facts: RoutingFacts;
  /** 以席位 rule_id 為鍵。 */
  assignees: Record<string, SeatAssignee>;
  /** 合併後的簽署序列：[主要角色, 兼任角色, 姓名]。 */
  expected: Array<[string, string[], string]>;
  /** 沒有合併時的簽署序列角色，用來證明合併後順序不變。 */
  unmerged: string[];
}

const CASES: MergeCase[] = [
  {
    title: '包租：甲方的當事人簽署人兼任專任管理人員',
    facts: lease('master_lease'),
    assignees: {
      'lease.master_lease.party_b': person('乙'),
      'lease.master_lease.practitioner': person('陳', CHEN),
      'lease.master_lease.party_a': person('陳甲', CHEN),
    },
    expected: [
      ['party_b', [], '乙'],
      ['practitioner', ['party_a'], '陳'],
    ],
    unmerged: ['party_b', 'practitioner', 'party_a'],
  },
  {
    title: '自管但承租人是包租業者：乙方的當事人簽署人兼任專任管理人員',
    facts: lease('self_managed', { lesseeIsMasterLessor: true }),
    assignees: {
      'lease.self_managed_lessee_master_lessor.party_a': person('甲'),
      'lease.self_managed_lessee_master_lessor.practitioner': person('陳', CHEN),
      'lease.self_managed_lessee_master_lessor.party_b': person('陳乙', CHEN),
    },
    expected: [
      ['party_a', [], '甲'],
      ['practitioner', ['party_b'], '陳'],
    ],
    unmerged: ['party_a', 'practitioner', 'party_b'],
  },
  {
    title: '委託管理合約：乙方（受託人）的當事人簽署人兼任專任管理人員',
    facts: { documentType: 'management', caseKind: 'management' },
    assignees: {
      'management.managed.party_a': person('甲'),
      'management.managed.practitioner': person('陳', CHEN),
      'management.managed.party_b': person('陳乙', CHEN),
    },
    expected: [
      ['party_a', [], '甲'],
      ['practitioner', ['party_b'], '陳'],
    ],
    unmerged: ['party_a', 'practitioner', 'party_b'],
  },
  {
    title: '居間加包租：合併後仍是三位，經紀人排在最後',
    facts: lease('master_lease', { brokerMediated: true }),
    assignees: {
      'lease.master_lease.party_b': person('乙'),
      'lease.master_lease.practitioner': person('陳', CHEN),
      'lease.master_lease.party_a': person('陳甲', CHEN),
      'lease.broker': person('經紀', { partyId: 'party-zhao', entityId: 'org-b' }),
    },
    expected: [
      ['party_b', [], '乙'],
      ['practitioner', ['party_a'], '陳'],
      ['practitioner', [], '經紀'],
    ],
    unmerged: ['party_b', 'practitioner', 'party_a', 'practitioner'],
  },
];

describe('buildSignerSequence：同一人合併', () => {
  it.each(CASES)('$title', ({ facts, assignees, expected, unmerged }) => {
    const plan = planOf(facts);
    const result = buildSignerSequence(plan, assignees, []);
    if (!result.ok) throw new Error('預期成功');

    expect(result.signers.map((s) => [s.role, s.concurrentRoles ?? [], s.name])).toEqual(expected);
    // 合併後順序不變：把兼任的當事人席位拿掉，其餘維持規則表的順序
    expect(plan.seats.map((s) => s.role)).toEqual(unmerged);
    const merged = findMergedSeats(plan, identitiesOf(assignees));
    const kept = plan.seats.filter((s) => !merged.some((m) => m.partyRuleId === s.ruleId));
    expect(result.signers.map((s) => s.role)).toEqual(kept.map((s) => s.role));
  });

  it('合併後的 email 取自執業人員帳號，驗證方式沿用執業人員席位', () => {
    const plan = planOf(lease('master_lease'));
    const result = buildSignerSequence(
      plan,
      {
        'lease.master_lease.party_b': person('乙'),
        'lease.master_lease.practitioner': { name: '陳怡君', email: 'account@example.com', identity: CHEN },
        'lease.master_lease.party_a': { name: '陳怡君', email: 'contract@example.com', identity: CHEN },
      },
      [],
    );
    if (!result.ok) throw new Error('預期成功');
    expect(result.signers[1]).toMatchObject({ role: 'practitioner', email: 'account@example.com', verifyMethods: ['email'] });
  });

  it('兩個角色的簽署區域放進同一位簽署人，維持輸入順序', () => {
    const plan = planOf(lease('master_lease'));
    const b = field('b', 'party_b');
    const practitioner1 = field('p1', 'practitioner', 'lease.master_lease.practitioner');
    const partyA = field('a1', 'party_a', 'lease.master_lease.party_a');
    const practitioner2 = field('p2', 'practitioner');
    const result = buildSignerSequence(
      plan,
      {
        'lease.master_lease.party_b': person('乙'),
        'lease.master_lease.practitioner': person('陳', CHEN),
        'lease.master_lease.party_a': person('陳甲', CHEN),
      },
      [practitioner1, partyA, b, practitioner2],
    );
    if (!result.ok) throw new Error('預期成功');
    expect(result.signers).toHaveLength(2);
    expect(result.signers[0].signatureFields).toEqual([b]);
    expect(result.signers[1].signatureFields).toEqual([practitioner1, partyA, practitioner2]);
  });
});

describe('buildSignerSequence：不合併的情況', () => {
  const plan = planOf(lease('master_lease'));
  const base = {
    'lease.master_lease.party_b': person('乙'),
    'lease.master_lease.practitioner': person('陳', CHEN),
  };

  it.each([
    ['party_id 不同', { 'lease.master_lease.party_a': person('王', WANG) }],
    ['party_id 相同但屬於不同的執業主體', { 'lease.master_lease.party_a': person('陳甲', { partyId: 'party-chen', entityId: 'org-other' }) }],
    ['當事人簽署人沒有身分資料', { 'lease.master_lease.party_a': person('陳甲') }],
  ])('%s：每個席位各是一位簽署人', (_title, rest) => {
    const result = buildSignerSequence(plan, { ...base, ...rest }, []);
    if (!result.ok) throw new Error('預期成功');
    expect(result.signers.map((s) => s.role)).toEqual(['party_b', 'practitioner', 'party_a']);
    expect(result.signers.every((s) => s.concurrentRoles === undefined)).toBe(true);
  });

  it('執業人員沒有身分資料：不合併', () => {
    const result = buildSignerSequence(
      plan,
      { ...base, 'lease.master_lease.practitioner': person('陳'), 'lease.master_lease.party_a': person('陳甲', CHEN) },
      [],
    );
    if (!result.ok) throw new Error('預期成功');
    expect(result.signers).toHaveLength(3);
  });

  it('執業人員同時是相對人（乙方）：不是執業主體的當事人，不合併', () => {
    const merged = findMergedSeats(plan, {
      'lease.master_lease.party_b': CHEN,
      'lease.master_lease.practitioner': CHEN,
      'lease.master_lease.party_a': WANG,
    });
    expect(merged).toEqual([]);
  });

  it('經紀人席位的執業主體不是合約當事人，不合併', () => {
    const brokered = planOf(lease('master_lease', { brokerMediated: true }));
    const merged = findMergedSeats(brokered, {
      'lease.master_lease.party_a': WANG,
      'lease.master_lease.practitioner': WANG,
      'lease.broker': WANG,
    });
    expect(merged.map((m) => m.practitionerRuleId)).toEqual(['lease.master_lease.practitioner']);
  });
});

describe('seatSignerIndexes：席位對到簽署序列的位置', () => {
  const brokered = planOf(lease('master_lease', { brokerMediated: true }));

  it('沒有合併：一個席位一個位置', () => {
    expect(seatSignerIndexes(brokered, [])).toEqual({
      'lease.master_lease.party_b': 0,
      'lease.master_lease.practitioner': 1,
      'lease.master_lease.party_a': 2,
      'lease.broker': 3,
    });
  });

  it('合併後：兼任的當事人席位指向執業人員席位的位置，其後的席位往前補', () => {
    const merged = findMergedSeats(brokered, {
      'lease.master_lease.practitioner': CHEN,
      'lease.master_lease.party_a': CHEN,
    });
    expect(seatSignerIndexes(brokered, merged)).toEqual({
      'lease.master_lease.party_b': 0,
      'lease.master_lease.practitioner': 1,
      'lease.master_lease.party_a': 1,
      'lease.broker': 2,
    });
  });
});

describe('fieldsOfSeat：每個席位各自的簽署區域', () => {
  it('合併後仍能分出每個席位有沒有簽署區域', () => {
    const plan = planOf(lease('master_lease'));
    const p = field('p', 'practitioner', 'lease.master_lease.practitioner');
    const a = field('a', 'party_a', 'lease.master_lease.party_a');
    expect(fieldsOfSeat(plan, 'lease.master_lease.practitioner', [p, a])).toEqual([p]);
    expect(fieldsOfSeat(plan, 'lease.master_lease.party_a', [p, a])).toEqual([a]);
    expect(fieldsOfSeat(plan, 'lease.master_lease.party_a', [p])).toEqual([]);
  });
});

function identitiesOf(assignees: Record<string, SeatAssignee>): Record<string, SeatIdentity | undefined> {
  return Object.fromEntries(Object.entries(assignees).map(([ruleId, a]) => [ruleId, a.identity]));
}
