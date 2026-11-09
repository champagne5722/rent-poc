import { describe, expect, it } from 'vitest';
import { createSeedPracticeRegistry, REGISTRY_UNAVAILABLE_REASON, type PracticeRegistryResolution } from '../practice-registry';
import type { RoutingFacts } from '../signature-routing';
import type { PractitionerAssignmentInput } from './seats';
import {
  evaluateSend,
  loadPrintedPractitioners,
  loadSeatOptions,
  validateAssignments,
  type EvaluateSendInput,
} from './service';

const TODAY = '2026-11-09';
const AT = '2026-11-09T12:00:00+08:00';
const seed: PracticeRegistryResolution = {
  available: true,
  registry: createSeedPracticeRegistry({ today: () => TODAY }),
};

const MASTER_LEASE: RoutingFacts = { documentType: 'lease', businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: false };
const PRACTITIONER_SLOT = 'lease.master_lease.practitioner';

// 包租業者北辰，當事人簽署人王建國，專任管理人員陳怡君
const FIELDS = {
  landlordName: '王建國',
  landlordEmail: 'wang.jianguo@beichen.example.com',
  tenantName: '王租客',
  tenantEmail: 'tenant@example.com',
};
const ASSIGNMENT: PractitionerAssignmentInput = { slot: PRACTITIONER_SLOT, entityId: 'org-pe-beichen', practitionerId: 'pr-chen', partySignerId: 'ps-wang' };

function input(patch: Partial<EvaluateSendInput> = {}): EvaluateSendInput {
  return { routing: MASTER_LEASE, fields: FIELDS, assignments: [ASSIGNMENT], at: AT, ...patch };
}

const codes = async (patch: Partial<EvaluateSendInput> = {}, resolution = seed) =>
  (await evaluateSend(input(patch), resolution)).reasons.map((r) => r.code);

describe('evaluateSend：由指派與登錄資料組出送簽前檢查的輸入', () => {
  it('包租：指派齊全且可簽章，執業人員的姓名與 email 取自登錄', async () => {
    const result = await evaluateSend(input(), seed);
    expect(result.ok).toBe(true);
    expect(result.assignees).toEqual({
      [PRACTITIONER_SLOT]: { name: '陳怡君', email: 'chen.yijun@beichen.example.com' },
    });
    expect(result.printed).toEqual({
      [PRACTITIONER_SLOT]: {
        name: '陳怡君',
        title: '租賃住宅管理人員',
        entityName: '北辰租賃住宅管理股份有限公司',
      },
    });
  });

  it('算出簽章紀錄的送簽資料：款次、規則、執業人員、任職、執業主體與當時的證書快照（MIL-70）', async () => {
    const result = await evaluateSend(input(), seed);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      ruleId: PRACTITIONER_SLOT,
      statuteRef: expect.stringContaining('§32'),
      ruleVersion: expect.any(Number),
      practitionerId: 'pr-chen',
      employmentId: 'emp-pr-chen',
      entityId: 'org-pe-beichen',
      licenseKind: 'master_lease',
      snapshotAtSend: {
        decidedAt: AT,
        certificateKind: 'rental_housing_manager',
        result: { signable: true, renewalWindow: null },
      },
    });
  });

  it('沒有指派執業人員：被擋下（P0-10 AC2）', async () => {
    expect(await codes({ assignments: [] })).toEqual(['practitioner_not_assigned']);
  });

  it('指派的人在登錄查不到：被擋下', async () => {
    expect(await codes({ assignments: [{ ...ASSIGNMENT, practitionerId: 'pr-ghost' }] })).toEqual(['practitioner_not_found']);
  });

  it('專任旗標為否的人被擋下（P0-12 AC4）', async () => {
    expect(await codes({ assignments: [{ ...ASSIGNMENT, practitionerId: 'pr-wu' }] })).toEqual(
      expect.arrayContaining(['not_full_time']),
    );
  });

  it('負責人沒有管理人員證書被擋下（P0-12 AC5）', async () => {
    const result = await evaluateSend(input({ assignments: [{ ...ASSIGNMENT, practitionerId: 'pr-zhang' }] }), seed);
    expect(result.reasons.map((r) => r.code)).toContain('certificate_missing');
    expect(result.reasons.find((r) => r.code === 'certificate_missing')!.message).toContain('負責人');
  });

  it('證書已失效、任職已結束的人被擋下', async () => {
    expect(await codes({ assignments: [{ ...ASSIGNMENT, practitionerId: 'pr-zhou' }] })).toEqual(['credential_not_signable']);
    expect(await codes({ assignments: [{ ...ASSIGNMENT, practitionerId: 'pr-xu' }] })).toEqual(['credential_not_signable']);
  });

  it('其他執業主體的人：任職與所選執業主體不符', async () => {
    expect(await codes({ assignments: [{ ...ASSIGNMENT, practitionerId: 'pr-su' }] })).toEqual(['employment_entity_mismatch']);
  });

  it('換證窗口內仍得送簽，附換證期限', async () => {
    const result = await evaluateSend(input({ assignments: [{ ...ASSIGNMENT, practitionerId: 'pr-lin' }] }), seed);
    expect(result.ok).toBe(true);
    expect(result.notices).toEqual([expect.objectContaining({ code: 'renewal_window', validUntil: '2027-02-09' })]);
  });

  describe('當事人簽署人', () => {
    it('沒有選當事人簽署人：被擋下', async () => {
      expect(await codes({ assignments: [{ ...ASSIGNMENT, partySignerId: null }] })).toEqual(['party_signer_not_assigned']);
    });
    it('合約的甲方資料與所選簽署人不同：被擋下，避免 PDF 與簽署人不一致', async () => {
      expect(await codes({ fields: { ...FIELDS, landlordEmail: 'other@example.com' } })).toEqual(['party_signer_mismatch']);
    });
    it('簽署人不屬於所選的執業主體：被擋下', async () => {
      expect(await codes({ assignments: [{ ...ASSIGNMENT, partySignerId: 'ps-su' }] })).toContain('party_signer_mismatch');
    });
    it('簽署人與執業人員是同一人：合併成一位簽署人，不再因 email 重複被擋下（MIL-76，細節在 service.merge.test.ts）', async () => {
      const result = await evaluateSend(
        input({
          fields: { ...FIELDS, landlordName: '陳怡君', landlordEmail: 'chen.yijun@beichen.example.com' },
          assignments: [{ ...ASSIGNMENT, partySignerId: 'ps-chen' }],
        }),
        seed,
      );
      expect(result.reasons).toEqual([]);
    });
  });

  describe('自管且承租人是包租業者：執業主體是乙方', () => {
    const reversed: RoutingFacts = { documentType: 'lease', businessType: 'self_managed', lesseeIsMasterLessor: true, brokerMediated: false };
    const slot = 'lease.self_managed_lessee_master_lessor.practitioner';
    const fields = {
      landlordName: '林屋主',
      landlordEmail: 'owner@example.com',
      tenantName: '王建國',
      tenantEmail: 'wang.jianguo@beichen.example.com',
    };
    it('乙方的當事人簽署人與專任管理人員齊全：可送簽', async () => {
      const result = await evaluateSend(
        input({ routing: reversed, fields, assignments: [{ ...ASSIGNMENT, slot }] }),
        seed,
      );
      expect(result.reasons).toEqual([]);
      expect(Object.keys(result.assignees)).toEqual([slot]);
    });
    it('乙方資料與所選簽署人不同：被擋下', async () => {
      expect(
        await codes({ routing: reversed, fields: { ...fields, tenantName: '別人' }, assignments: [{ ...ASSIGNMENT, slot }] }),
      ).toEqual(['party_signer_mismatch']);
    });
  });

  describe('居間：經紀人席位', () => {
    const brokered: RoutingFacts = { ...MASTER_LEASE, brokerMediated: true } as RoutingFacts;
    const broker = { slot: 'lease.broker', entityId: 'org-pe-yunding', practitionerId: 'pr-zhao', partySignerId: null };
    it('經紀人不要求專任，沒有當事人簽署人', async () => {
      const result = await evaluateSend(input({ routing: brokered, assignments: [ASSIGNMENT, broker] }), seed);
      expect(result.reasons).toEqual([]);
      expect(Object.keys(result.assignees)).toEqual([PRACTITIONER_SLOT, 'lease.broker']);
    });
    it('經紀營業員不得簽章', async () => {
      expect(
        await codes({ routing: brokered, assignments: [ASSIGNMENT, { ...broker, practitionerId: 'pr-sun' }] }),
      ).toEqual(['certificate_kind_not_allowed']);
    });
  });

  it('兩方合約不需要執業人員：不查登錄，指派可以是空的', async () => {
    const selfManaged: RoutingFacts = { documentType: 'lease', businessType: 'self_managed', lesseeIsMasterLessor: false, brokerMediated: false };
    const result = await evaluateSend(input({ routing: selfManaged, assignments: [] }), { available: false, reason: 'x' });
    expect(result).toMatchObject({ ok: true, reasons: [], assignees: {}, records: [] });
  });

  it('正式金鑰下沒有真實 adapter：要求執業人員的組合被擋下', async () => {
    const result = await evaluateSend(input(), { available: false, reason: REGISTRY_UNAVAILABLE_REASON });
    expect(result.ok).toBe(false);
    expect(result.reasons.map((r) => r.code)).toEqual(['registry_unavailable']);
    expect(result.assignees).toEqual({});
  });

  it('出租權源的原因併進清單', async () => {
    const result = await evaluateSend(
      input({
        leasingAuthority: { rentalUnitId: 'ru-1', primaryAuthority: null, pendingKeyCollision: null, hasPendingSuspectedDuplicate: false },
      }),
      seed,
    );
    expect(result.reasons.map((r) => r.code)).toEqual(['no_primary_authority']);
  });
});

describe('loadSeatOptions：wizard 的指派選項', () => {
  it('只列可簽章的執業人員，換證窗口內的人附期限', async () => {
    const options = await loadSeatOptions(MASTER_LEASE, seed, AT);
    expect(options).toMatchObject({ available: true, registryKind: 'seed' });
    if (!options.available) return;
    expect(options.seats).toHaveLength(1);
    const seat = options.seats[0];
    expect(seat).toMatchObject({ ruleId: PRACTITIONER_SLOT, partyRole: 'party_a', licenseKind: 'master_lease', label: '執業人員（租賃住宅管理人員）' });
    const beichen = seat.entities.find((e) => e.id === 'org-pe-beichen')!;
    // 專任旗標為否、負責人沒有證書、證書失效、任職結束的人都不列
    expect(beichen.practitioners.map((p) => p.id)).toEqual(['pr-chen', 'pr-lin']);
    expect(beichen.practitioners.find((p) => p.id === 'pr-lin')!.renewalWindow).toEqual({
      validUntil: '2027-02-09',
      windowStartsOn: '2026-08-09',
    });
    expect(beichen.practitioners[0].email).toBe('chen.yijun@beichen.example.com');
    expect(beichen.partySigners.map((s) => s.id)).toEqual(['ps-wang', 'ps-li', 'ps-chen']);
    // 只列有包租業別的執業主體
    expect(seat.entities.map((e) => e.id)).toEqual(['org-pe-beichen', 'org-pe-suilin']);
  });

  it('居間的經紀人席位沒有當事人簽署人', async () => {
    const options = await loadSeatOptions({ ...MASTER_LEASE, brokerMediated: true } as RoutingFacts, seed, AT);
    if (!options.available) throw new Error('x');
    const broker = options.seats.find((s) => s.ruleId === 'lease.broker')!;
    expect(broker.partyRole).toBeNull();
    expect(broker.entities.map((e) => e.id)).toEqual(['org-pe-yunding']);
    expect(broker.entities[0].practitioners.map((p) => p.id)).toEqual(['pr-zhao']);
  });

  it('沒有執業人員席位的組合：沒有選項', async () => {
    const selfManaged: RoutingFacts = { documentType: 'lease', businessType: 'self_managed', lesseeIsMasterLessor: false, brokerMediated: false };
    expect(await loadSeatOptions(selfManaged, seed, AT)).toEqual({ available: true, registryKind: 'seed', seats: [] });
  });

  it('登錄資料來源不可用：回報原因', async () => {
    expect(await loadSeatOptions(MASTER_LEASE, { available: false, reason: 'r' }, AT)).toEqual({ available: false, reason: 'r' });
  });
});

describe('loadPrintedPractitioners：草稿預覽的簽署欄', () => {
  it('已指派的席位印姓名、法定稱謂、執業主體', async () => {
    expect(await loadPrintedPractitioners(MASTER_LEASE, [ASSIGNMENT], seed)).toEqual({
      [PRACTITIONER_SLOT]: { name: '陳怡君', title: '租賃住宅管理人員', entityName: '北辰租賃住宅管理股份有限公司' },
    });
  });
  it('尚未指派或登錄不可用時，不印（留底線）', async () => {
    expect(await loadPrintedPractitioners(MASTER_LEASE, [], seed)).toEqual({});
    expect(await loadPrintedPractitioners(MASTER_LEASE, [ASSIGNMENT], { available: false, reason: 'r' })).toEqual({});
  });
});

describe('validateAssignments：存指派時的檢查', () => {
  const check = (
    assignments: Array<Partial<PractitionerAssignmentInput>>,
    routing: RoutingFacts = MASTER_LEASE,
    resolution: PracticeRegistryResolution = seed,
  ) =>
    validateAssignments(routing, assignments.map((a) => ({ ...ASSIGNMENT, ...a })), resolution);

  it('正確的指派通過', async () => {
    expect(await check([{}])).toBeNull();
  });
  it('換證窗口內的人可以存', async () => {
    expect(await check([{ practitionerId: 'pr-lin' }])).toBeNull();
  });
  it('沒有指派時通過，不查登錄', async () => {
    expect(await validateAssignments(MASTER_LEASE, [], { available: false, reason: 'r' })).toBeNull();
  });
  it('登錄資料來源不可用：回原因', async () => {
    expect(await check([{}], MASTER_LEASE, { available: false, reason: 'r' })).toBe('r');
  });
  it('席位不在簽署序列內', async () => {
    expect(await check([{ slot: 'lease.broker' }])).toContain('沒有這個執業人員席位');
  });
  it('當事人席位不是執業人員席位', async () => {
    expect(await check([{ slot: 'lease.master_lease.party_a' }])).toContain('沒有這個執業人員席位');
  });
  it('同一席位重複', async () => {
    expect(await check([{}, { practitionerId: 'pr-lin' }])).toContain('重複指派');
  });
  it('執業主體沒有對應的業別', async () => {
    expect(await check([{ entityId: 'org-pe-yaoshi', practitionerId: 'pr-yao', partySignerId: 'ps-yao' }])).toBe(
      '所選的執業主體沒有這個席位要求的業別',
    );
  });
  it('專任旗標為否的人不在候選清單內（P0-12 AC4）', async () => {
    expect(await check([{ practitionerId: 'pr-wu' }])).toBe('所選的執業人員不在這個席位的候選清單內');
  });
  it('負責人沒有證書不在候選清單內（P0-12 AC5）', async () => {
    expect(await check([{ practitionerId: 'pr-zhang' }])).toBe('所選的執業人員不在這個席位的候選清單內');
  });
  it('別的執業主體的人不在候選清單內', async () => {
    expect(await check([{ practitionerId: 'pr-su' }])).toBe('所選的執業人員不在這個席位的候選清單內');
  });
  it('已存的指派原樣再存：即使那個人現在不在候選清單內，仍可存（才換得了人）', async () => {
    const wu = { ...ASSIGNMENT, practitionerId: 'pr-wu' };
    expect(await validateAssignments(MASTER_LEASE, [wu], seed, [wu])).toBeNull();
    expect(await validateAssignments(MASTER_LEASE, [wu], seed, [])).toBe('所選的執業人員不在這個席位的候選清單內');
    // 只要有欄位改動就重查
    expect(await validateAssignments(MASTER_LEASE, [{ ...wu, partySignerId: 'ps-li' }], seed, [wu])).toBe(
      '所選的執業人員不在這個席位的候選清單內',
    );
  });
  it('當事人簽署人不屬於所選的執業主體', async () => {
    expect(await check([{ partySignerId: 'ps-su' }])).toBe('當事人簽署人必須是所選執業主體的成員');
  });
  it('當事人簽署人可以先留空，送簽前再擋', async () => {
    expect(await check([{ partySignerId: null }])).toBeNull();
  });
  it('經紀人席位不能帶當事人簽署人', async () => {
    const brokered: RoutingFacts = { ...MASTER_LEASE, brokerMediated: true } as RoutingFacts;
    expect(
      await check([{ slot: 'lease.broker', entityId: 'org-pe-yunding', practitionerId: 'pr-zhao', partySignerId: 'ps-yun' }], brokered),
    ).toContain('沒有當事人簽署人');
    expect(
      await check([{ slot: 'lease.broker', entityId: 'org-pe-yunding', practitionerId: 'pr-zhao', partySignerId: null }], brokered),
    ).toBeNull();
  });
});
