import { describe, expect, it } from 'vitest';
import { createSeedPracticeRegistry, type PracticeRegistryResolution } from '../practice-registry';
import type { RoutingFacts } from '../signature-routing';
import type { PractitionerAssignmentInput } from './seats';
import { evaluateSend, type EvaluateSendInput } from './service';

// 同一人兼任與經紀人第四位：送簽前評估的結果（MIL-76）。

const AT = '2026-11-09T12:00:00+08:00';
const seed: PracticeRegistryResolution = {
  available: true,
  registry: createSeedPracticeRegistry({ today: () => '2026-11-09' }),
};

const MASTER_LEASE: RoutingFacts = { documentType: 'lease', caseKind: 'sublease', brokerMediated: false };
const BROKERED: RoutingFacts = { ...MASTER_LEASE, brokerMediated: true } as RoutingFacts;
const MANAGER_SLOT = 'lease.master_lease.practitioner';
const PARTY_A_SLOT = 'lease.master_lease.party_a';
const BROKER_SLOT = 'lease.broker';

const CHEN_EMAIL = 'chen.yijun@beichen.example.com';
const CHEN_FIELDS = { landlordName: '陳怡君', landlordEmail: CHEN_EMAIL, tenantName: '王租客', tenantEmail: 'tenant@example.com' };
const WANG_FIELDS = { ...CHEN_FIELDS, landlordName: '王建國', landlordEmail: 'wang.jianguo@beichen.example.com' };

const manager = (partySignerId: string): PractitionerAssignmentInput => ({
  slot: MANAGER_SLOT,
  entityId: 'org-pe-beichen',
  practitionerId: 'pr-chen',
  partySignerId,
});
const broker = (practitionerId = 'pr-zhao'): PractitionerAssignmentInput => ({
  slot: BROKER_SLOT,
  entityId: 'org-pe-yunding',
  practitionerId,
  partySignerId: null,
});

function input(patch: Partial<EvaluateSendInput>): EvaluateSendInput {
  return { routing: MASTER_LEASE, fields: CHEN_FIELDS, assignments: [manager('ps-chen')], at: AT, ...patch };
}

describe('evaluateSend：同一人兼任', () => {
  it('當事人簽署人就是專任管理人員：可送簽，回報合併的席位', async () => {
    const result = await evaluateSend(input({}), seed);
    expect(result.reasons).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.merges).toEqual([{ practitionerRuleId: MANAGER_SLOT, partyRuleId: PARTY_A_SLOT, partyRole: 'party_a' }]);
  });

  it('簽章紀錄的 signerIndex 是合併後的位置：乙方 0、合併的簽署人 1', async () => {
    const result = await evaluateSend(input({}), seed);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ ruleId: MANAGER_SLOT, signerIndex: 1, practitionerId: 'pr-chen' });
  });

  it('身分資料交給組簽署序列的人，兩個席位都帶 partyId 與執業主體', async () => {
    const result = await evaluateSend(input({}), seed);
    expect(result.identities).toEqual({
      [MANAGER_SLOT]: { partyId: 'party-chen', entityId: 'org-pe-beichen' },
      [PARTY_A_SLOT]: { partyId: 'party-chen', entityId: 'org-pe-beichen' },
    });
  });

  it('當事人簽署人是別人：不合併，signerIndex 維持席位順序', async () => {
    const result = await evaluateSend(input({ fields: WANG_FIELDS, assignments: [manager('ps-wang')] }), seed);
    expect(result.ok).toBe(true);
    expect(result.merges).toEqual([]);
    expect(result.records[0].signerIndex).toBe(1);
    expect(result.identities[PARTY_A_SLOT]).toEqual({ partyId: 'party-ps-wang', entityId: 'org-pe-beichen' });
  });

  it('合約的甲方資料與所選的當事人簽署人不同：仍擋下，不因合併放行', async () => {
    const result = await evaluateSend(input({ fields: { ...CHEN_FIELDS, landlordEmail: 'other@example.com' } }), seed);
    expect(result.reasons.map((r) => r.code)).toEqual(['party_signer_mismatch']);
    expect(result.records).toEqual([]);
  });

  it('執業人員同時是相對人（乙方）：email 重複，仍被擋下', async () => {
    const result = await evaluateSend(input({ fields: { ...CHEN_FIELDS, tenantName: '陳怡君', tenantEmail: CHEN_EMAIL } }), seed);
    expect(result.reasons.map((r) => r.code)).toEqual(['duplicate_email']);
  });

  it('自管但承租人是包租業者：乙方的當事人簽署人兼任專任管理人員', async () => {
    const reversed: RoutingFacts = { documentType: 'lease', caseKind: 'master_lease', brokerMediated: false };
    const slot = 'lease.self_managed_lessee_master_lessor.practitioner';
    const result = await evaluateSend(
      input({
        routing: reversed,
        fields: { landlordName: '林屋主', landlordEmail: 'owner@example.com', tenantName: '陳怡君', tenantEmail: CHEN_EMAIL },
        assignments: [{ ...manager('ps-chen'), slot }],
      }),
      seed,
    );
    expect(result.reasons).toEqual([]);
    expect(result.merges).toEqual([
      { practitionerRuleId: slot, partyRuleId: 'lease.self_managed_lessee_master_lessor.party_b', partyRole: 'party_b' },
    ]);
    // 甲方 0、合併的簽署人 1
    expect(result.records[0].signerIndex).toBe(1);
  });
});

describe('evaluateSend：居間加包租的第四位簽署人', () => {
  it('四位依序：乙方、專任管理人員、甲方、經紀人，兩筆簽章紀錄的 signerIndex 與款次不同', async () => {
    const result = await evaluateSend(
      input({ routing: BROKERED, fields: WANG_FIELDS, assignments: [manager('ps-wang'), broker()] }),
      seed,
    );
    expect(result.reasons).toEqual([]);
    expect(result.records.map((r) => [r.ruleId, r.signerIndex, r.statuteRef])).toEqual([
      [MANAGER_SLOT, 1, '§32 第 2、3 款'],
      [BROKER_SLOT, 3, '經紀條例 §22'],
    ]);
    expect(result.records[0].statuteRef).not.toBe(result.records[1].statuteRef);
    expect(result.records.map((r) => r.licenseKind)).toEqual(['master_lease', 'brokerage']);
  });

  it('兼任合併加經紀人：經紀人的 signerIndex 往前補成 2', async () => {
    const result = await evaluateSend(input({ routing: BROKERED, assignments: [manager('ps-chen'), broker()] }), seed);
    expect(result.reasons).toEqual([]);
    expect(result.records.map((r) => [r.ruleId, r.signerIndex])).toEqual([
      [MANAGER_SLOT, 1],
      [BROKER_SLOT, 2],
    ]);
  });

  it('居間但沒有指派經紀人：被擋下並指出席位', async () => {
    const result = await evaluateSend(input({ routing: BROKERED, fields: WANG_FIELDS, assignments: [manager('ps-wang')] }), seed);
    expect(result.reasons).toEqual([expect.objectContaining({ code: 'practitioner_not_assigned', seatRuleId: BROKER_SLOT })]);
  });

  it('經紀營業員不得簽章：送簽前檢查擋下', async () => {
    const result = await evaluateSend(
      input({ routing: BROKERED, fields: WANG_FIELDS, assignments: [manager('ps-wang'), broker('pr-sun')] }),
      seed,
    );
    expect(result.reasons.map((r) => r.code)).toEqual(['certificate_kind_not_allowed']);
    expect(result.reasons[0].message).toContain('不動產經紀營業員');
  });
});
