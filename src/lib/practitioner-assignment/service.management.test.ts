import { describe, expect, it } from 'vitest';
import { createSeedPracticeRegistry, type PracticeRegistryResolution } from '../practice-registry';
import type { RoutingFacts } from '../signature-routing';
import type { PractitionerAssignmentInput } from './seats';
import { evaluateSend, loadSeatOptions, validateAssignments, type EvaluateSendInput } from './service';

// 委託管理合約的受託人（MIL-74、P0-11 AC1、AC2）：受託人取自 practiceRegistry，
// 缺少 H706011（代管業別）或業別未驗證時擋下並說明。

const TODAY = '2026-11-09';
const AT = '2026-11-09T12:00:00+08:00';
const seed: PracticeRegistryResolution = {
  available: true,
  registry: createSeedPracticeRegistry({ today: () => TODAY }),
};

const MANAGED: RoutingFacts = { documentType: 'management', caseKind: 'management' };
const SLOT = 'management.managed.practitioner';

// 受託人北辰（代管業別已驗證），當事人簽署人王建國，專任管理人員陳怡君
const FIELDS = {
  mandatorName: '陳屋主',
  mandatorEmail: 'owner@example.com',
  mandataryName: '王建國',
  mandataryEmail: 'wang.jianguo@beichen.example.com',
};
const ASSIGNMENT: PractitionerAssignmentInput = {
  slot: SLOT,
  entityId: 'org-pe-beichen',
  practitionerId: 'pr-chen',
  partySignerId: 'ps-wang',
};

function input(patch: Partial<EvaluateSendInput> = {}): EvaluateSendInput {
  return { routing: MANAGED, contractType: 'management', fields: FIELDS, assignments: [ASSIGNMENT], at: AT, ...patch };
}

describe('委託管理合約：evaluateSend', () => {
  it('已驗證的受託人帶入乙方，執業人員的姓名與 email 取自登錄', async () => {
    const result = await evaluateSend(input(), seed);
    expect(result.ok).toBe(true);
    expect(result.assignees).toEqual({ [SLOT]: { name: '陳怡君', email: 'chen.yijun@beichen.example.com' } });
    expect(result.printed[SLOT]).toEqual({
      name: '陳怡君',
      title: '租賃住宅管理人員',
      entityName: '北辰租賃住宅管理股份有限公司',
    });
  });

  it('乙方的姓名與所選的當事人簽署人不同：被擋下', async () => {
    const result = await evaluateSend(input({ fields: { ...FIELDS, mandataryName: '別人' } }), seed);
    expect(result.reasons.map((r) => r.code)).toContain('party_signer_mismatch');
  });

  it('受託人沒有代管業別（只有包租）：被擋下，原因含業別未驗證', async () => {
    const result = await evaluateSend(
      input({
        assignments: [{ slot: SLOT, entityId: 'org-pe-suilin', practitionerId: 'pr-su', partySignerId: 'ps-su' }],
        fields: { ...FIELDS, mandataryName: '蘇志明', mandataryEmail: 'su.zhiming@suilin.example.com' },
      }),
      seed,
    );
    expect(result.ok).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('沒有指派執業人員：被擋下（P0-11 AC6 的簽章欄要求）', async () => {
    const result = await evaluateSend(input({ assignments: [] }), seed);
    expect(result.ok).toBe(false);
    expect(result.reasons.map((r) => r.code)).toContain('practitioner_not_assigned');
  });
});

describe('委託管理合約：loadSeatOptions', () => {
  it('列出全部執業主體，缺少代管業別或業別未驗證的標示不能選並說明原因', async () => {
    const options = await loadSeatOptions(MANAGED, seed, AT);
    if (!options.available) throw new Error(options.reason);
    expect(options.seats).toHaveLength(1);
    const seat = options.seats[0];
    expect(seat.ruleId).toBe(SLOT);
    expect(seat.partyRole).toBe('party_b');
    const byId = Object.fromEntries(seat.entities.map((e) => [e.id, e]));

    expect(byId['org-pe-beichen'].blockedReason).toBeUndefined();
    expect(byId['org-pe-beichen'].partySigners.map((s) => s.id)).toContain('ps-wang');
    expect(byId['org-pe-beichen'].practitioners.map((p) => p.id)).toContain('pr-chen');

    // 只有包租與經紀業別的執業主體：缺少 H706011
    expect(byId['org-pe-suilin'].blockedReason).toBe('缺少租賃住宅代管業的營業項目 H706011，不能擔任受託人');
    expect(byId['org-pe-yunding'].blockedReason).toBe('缺少租賃住宅代管業的營業項目 H706011，不能擔任受託人');

    // 登記了代管業別但尚未驗證
    expect(byId['org-pe-xinghe'].blockedReason).toBe('租賃住宅代管業的業別尚未驗證，不能擔任受託人');
  });

  it('租賃合約的選項不變：只列持有該業別的執業主體，沒有 blockedReason', async () => {
    const options = await loadSeatOptions(
      { documentType: 'lease', caseKind: 'lease', businessType: 'managed', brokerMediated: false },
      seed,
      AT,
    );
    if (!options.available) throw new Error(options.reason);
    // 代管的租賃合約沒有執業人員席位
    expect(options.seats).toEqual([]);
    const master = await loadSeatOptions(
      { documentType: 'lease', caseKind: 'sublease', brokerMediated: false },
      seed,
      AT,
    );
    if (!master.available) throw new Error(master.reason);
    expect(master.seats[0].entities.every((e) => e.blockedReason === undefined)).toBe(true);
    expect(master.seats[0].entities.map((e) => e.id)).not.toContain('org-pe-yunding');
  });
});

describe('委託管理合約：validateAssignments', () => {
  it('已驗證的受託人通過', async () => {
    expect(await validateAssignments(MANAGED, [ASSIGNMENT], seed)).toBeNull();
  });

  it('受託人缺少 H706011：擋下並說明', async () => {
    const error = await validateAssignments(
      MANAGED,
      [{ slot: SLOT, entityId: 'org-pe-suilin', practitionerId: 'pr-su', partySignerId: 'ps-su' }],
      seed,
    );
    expect(error).toBe('缺少租賃住宅代管業的營業項目 H706011，不能擔任受託人');
  });

  it('受託人的代管業別未驗證：擋下並說明', async () => {
    const error = await validateAssignments(
      MANAGED,
      [{ slot: SLOT, entityId: 'org-pe-xinghe', practitionerId: 'pr-xing', partySignerId: 'ps-xing' }],
      seed,
      [],
      AT,
    );
    expect(error).toBe('租賃住宅代管業的業別尚未驗證，不能擔任受託人');
  });
});
