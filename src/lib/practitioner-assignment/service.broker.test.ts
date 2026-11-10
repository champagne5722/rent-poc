import { describe, expect, it } from 'vitest';
import { createSeedPracticeRegistry, type PracticeRegistryResolution } from '../practice-registry';
import type { RoutingFacts } from '../signature-routing';
import type { PractitionerAssignmentInput } from './seats';
import { BROKER_ONLY_NOTICE, loadSeatOptions, validateAssignments } from './service';

// 經紀人席位只能綁定不動產經紀人，經紀營業員不得簽章（P0-12 AC6，MIL-76）。

const AT = '2026-11-09T12:00:00+08:00';
const seed: PracticeRegistryResolution = {
  available: true,
  registry: createSeedPracticeRegistry({ today: () => '2026-11-09' }),
};
const BROKERED: RoutingFacts = {
  documentType: 'lease',
  caseKind: 'sublease',
  brokerMediated: true,
};

const broker = (practitionerId: string): PractitionerAssignmentInput => ({
  slot: 'lease.broker',
  entityId: 'org-pe-yunding',
  practitionerId,
  partySignerId: null,
});

describe('validateAssignments：經紀人席位', () => {
  it('不動產經紀人通過', async () => {
    expect(await validateAssignments(BROKERED, [broker('pr-zhao')], seed)).toBeNull();
  });

  it('指派經紀營業員：拒絕並說明原因，指出姓名與證書種類', async () => {
    const error = await validateAssignments(BROKERED, [broker('pr-sun')], seed);
    expect(error).toBe('孫小美是不動產經紀營業員，不得簽章。經紀人席位只能指派不動產經紀人。');
  });

  it('已存的經紀營業員原樣再存也要拒絕：這是法定限制，不是資料過期', async () => {
    const sun = broker('pr-sun');
    expect(await validateAssignments(BROKERED, [sun], seed, [sun])).toBe(
      '孫小美是不動產經紀營業員，不得簽章。經紀人席位只能指派不動產經紀人。',
    );
  });

  it('租賃住宅管理人員不能當經紀人：不在候選清單內', async () => {
    const error = await validateAssignments(BROKERED, [{ ...broker('pr-chen'), entityId: 'org-pe-beichen' }], seed);
    expect(error).toBe('所選的執業主體沒有這個席位要求的業別');
  });
});

describe('loadSeatOptions：經紀人席位', () => {
  it('候選只有不動產經紀人，經紀營業員不在選單；席位帶說明', async () => {
    const options = await loadSeatOptions(BROKERED, seed, AT);
    if (!options.available) throw new Error('預期可用');
    const seat = options.seats.find((s) => s.ruleId === 'lease.broker')!;
    expect(seat.label).toBe('執業人員（不動產經紀人）');
    expect(seat.licenseKind).toBe('brokerage');
    expect(seat.entities.flatMap((e) => e.practitioners.map((p) => p.id))).toEqual(['pr-zhao']);
    expect(seat.notice).toBe(BROKER_ONLY_NOTICE);
  });

  it('專任管理人員席位沒有這則說明', async () => {
    const options = await loadSeatOptions(BROKERED, seed, AT);
    if (!options.available) throw new Error('預期可用');
    const manager = options.seats.find((s) => s.ruleId === 'lease.master_lease.practitioner')!;
    expect(manager.notice).toBeUndefined();
  });
});
