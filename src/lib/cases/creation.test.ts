import { describe, expect, it } from 'vitest';
import {
  decideCaseCreation,
  type CaseCreationInput,
  type CaseCreationResult,
  type NewLeaseCaseInput,
  type NewManagementCaseInput,
  type SuccessorCaseInput,
} from './creation';
import { decideCaseTransition } from './transitions';

const NOW = new Date('2026-11-08T02:00:00Z');
const NOW_ISO = '2026-11-08T02:00:00.000Z';

function newLease(overrides: Partial<NewLeaseCaseInput> = {}): NewLeaseCaseInput {
  return {
    type: 'new_lease',
    caseId: 'case-1',
    rentalUnitId: 'unit-1',
    hostOrg: { orgId: 'org-owner', kind: 'owner' },
    businessType: 'self_managed',
    lessorPartyId: 'party-owner',
    ownerPartyId: null,
    brokerPartyId: null,
    practice: null,
    mandateCase: null,
    ...overrides,
  };
}

const VERIFIED_PRACTICE = { entityStatus: 'verified', hasSignableManager: true } as const;
const ACTIVE_MANDATE = { id: 'mcase-1', state: 'active', coversRentalUnit: true } as const;

function managedLease(overrides: Partial<NewLeaseCaseInput> = {}): NewLeaseCaseInput {
  return newLease({
    hostOrg: { orgId: 'org-pm', kind: 'practice' },
    businessType: 'managed',
    lessorPartyId: 'party-owner',
    practice: VERIFIED_PRACTICE,
    mandateCase: ACTIVE_MANDATE,
    ...overrides,
  });
}

function newMandate(overrides: Partial<NewManagementCaseInput> = {}): NewManagementCaseInput {
  return {
    type: 'new_management',
    caseId: 'mcase-1',
    hostOrg: { orgId: 'org-pm', kind: 'practice' },
    mandatorPartyId: 'party-owner',
    mandataryPartyId: 'party-pm',
    validUntil: '2027-11-07',
    ...overrides,
  };
}

function successor(overrides: Partial<SuccessorCaseInput> = {}): SuccessorCaseInput {
  return {
    type: 'successor_lease',
    caseId: 'case-2',
    rentalUnitId: 'unit-1',
    predecessorCaseId: 'case-1',
    handoverId: 'ho-1',
    receiverOrg: { orgId: 'org-pm-2', kind: 'practice' },
    businessType: 'managed',
    lessorPartyId: 'party-owner',
    lesseePartyIds: ['party-lessee'],
    coLesseePartyIds: [],
    ...overrides,
  };
}

function reasonCodes(result: CaseCreationResult): string[] {
  return result.ok ? [] : result.reasons.map((r) => r.code);
}

function accepted(result: CaseCreationResult) {
  if (!result.ok) throw new Error(`預期建立成功，實際被擋下：${reasonCodes(result).join(', ')}`);
  return result;
}

describe('decideCaseCreation：新租賃案件', () => {
  it('屋主組織建立自管案件：draft、沒有合約、lessor 是屋主，記 created', () => {
    expect(decideCaseCreation(newLease(), NOW)).toEqual({
      ok: true,
      case: {
        kind: 'lease',
        id: 'case-1',
        orgId: 'org-owner',
        state: 'draft',
        stateVersion: 0,
        currentContractId: null,
        businessType: 'self_managed',
        rentalUnitId: 'unit-1',
        linkedMandateCaseId: null,
        predecessorCaseId: null,
        handoverId: null,
      },
      members: [{ partyId: 'party-owner', relation: 'lessor' }],
      event: {
        type: 'created',
        occurredAt: NOW_ISO,
        payload: {
          kind: 'lease',
          businessType: 'self_managed',
          rentalUnitId: 'unit-1',
          linkedMandateCaseId: null,
        },
      },
    });
  });

  it('建立出來的 draft 案件接得上 decideCaseTransition：送簽進 signing', () => {
    const { case: created } = accepted(decideCaseCreation(newLease(), NOW));
    const next = decideCaseTransition(
      { kind: 'lease', id: created.id, state: 'draft', stateVersion: created.stateVersion, businessType: 'self_managed', currentContractId: 'contract-1' },
      { type: 'contract_sent', contractId: 'contract-1' },
      NOW,
    );
    expect(next?.state).toBe('signing');
  });

  it('經紀業者居間：加 broker 成員', () => {
    const { members } = accepted(decideCaseCreation(newLease({ brokerPartyId: 'party-broker' }), NOW));
    expect(members).toEqual([
      { partyId: 'party-owner', relation: 'lessor' },
      { partyId: 'party-broker', relation: 'broker' },
    ]);
  });

  describe('主辦組織與業務類型（ADR-0023 決議 1）', () => {
    it.each([
      ['owner', 'self_managed', true],
      ['owner', 'managed', false],
      ['owner', 'master_lease', false],
      ['practice', 'self_managed', false],
      ['practice', 'managed', true],
      ['practice', 'master_lease', true],
    ] as const)('%s 組織建立 %s 案件：允許 %s', (kind, businessType, allowed) => {
      const input = managedLease({ hostOrg: { orgId: 'org-x', kind }, businessType });
      const result = decideCaseCreation(input, NOW);
      expect(result.ok).toBe(allowed);
      if (!allowed) expect(reasonCodes(result)).toContain('business_type_not_allowed');
    });
  });

  describe('執業主體組織的檢查', () => {
    it.each([['pending'], ['lapsed'], [null]] as const)('業別狀態是 %s → 擋下（P0-02 AC4）', (entityStatus) => {
      const result = decideCaseCreation(
        managedLease({ practice: { entityStatus, hasSignableManager: true } }),
        NOW,
      );
      expect(reasonCodes(result)).toEqual(['practice_entity_not_verified']);
    });

    it('沒有可簽章的專任管理人員 → 擋下（P0-05 規則 4）', () => {
      const result = decideCaseCreation(
        managedLease({ practice: { entityStatus: 'verified', hasSignableManager: false } }),
        NOW,
      );
      expect(reasonCodes(result)).toEqual(['no_signable_manager']);
    });

    it('沒有提供執業主體事實 → 視為未驗證', () => {
      expect(reasonCodes(decideCaseCreation(managedLease({ practice: null }), NOW))).toEqual([
        'practice_entity_not_verified',
        'no_signable_manager',
      ]);
    });

    it('屋主組織的案件不看執業主體事實', () => {
      expect(decideCaseCreation(newLease({ practice: null }), NOW).ok).toBe(true);
    });
  });

  describe('代管案件（ADR-0023 決議 4）', () => {
    it('連到有效且涵蓋該租賃單位的委託管理案件：建立成功，記下連結', () => {
      const result = accepted(decideCaseCreation(managedLease(), NOW));
      expect(result.case).toMatchObject({ businessType: 'managed', linkedMandateCaseId: 'mcase-1', orgId: 'org-pm' });
      expect(result.event.payload).toMatchObject({ linkedMandateCaseId: 'mcase-1' });
      expect(result.members).toEqual([{ partyId: 'party-owner', relation: 'lessor' }]);
    });

    it('沒有委託管理案件 → 擋下（P0-09 AC3）', () => {
      expect(reasonCodes(decideCaseCreation(managedLease({ mandateCase: null }), NOW))).toEqual(['no_valid_mandate']);
    });

    it('委託管理案件沒涵蓋這個租賃單位 → 擋下', () => {
      const mandateCase = { ...ACTIVE_MANDATE, coversRentalUnit: false };
      expect(reasonCodes(decideCaseCreation(managedLease({ mandateCase }), NOW))).toEqual(['no_valid_mandate']);
    });

    it.each(['draft', 'signing', 'terminated', 'expired', 'aborted'] as const)(
      '委託管理案件是 %s（不是 active）→ 擋下',
      (state) => {
        const mandateCase = { ...ACTIVE_MANDATE, state };
        expect(reasonCodes(decideCaseCreation(managedLease({ mandateCase }), NOW))).toEqual(['no_valid_mandate']);
      },
    );

    it('同時有多個問題時，回傳全部原因', () => {
      const result = decideCaseCreation(
        managedLease({ practice: { entityStatus: 'lapsed', hasSignableManager: false }, mandateCase: null }),
        NOW,
      );
      expect(reasonCodes(result)).toEqual(['practice_entity_not_verified', 'no_signable_manager', 'no_valid_mandate']);
    });

    it('被擋下的原因都帶中文說明', () => {
      const result = decideCaseCreation(managedLease({ mandateCase: null }), NOW);
      expect(!result.ok && result.reasons[0].message).toMatch(/委託/);
    });
  });

  describe('包租案件', () => {
    const masterLease = (overrides: Partial<NewLeaseCaseInput> = {}) =>
      managedLease({ businessType: 'master_lease', lessorPartyId: 'party-pm', mandateCase: null, ...overrides });

    it('lessor 是包租業者，不需要委託管理案件；有屋主時加 owner 成員', () => {
      const result = accepted(decideCaseCreation(masterLease({ ownerPartyId: 'party-owner' }), NOW));
      expect(result.case).toMatchObject({ businessType: 'master_lease', linkedMandateCaseId: null });
      expect(result.members).toEqual([
        { partyId: 'party-pm', relation: 'lessor' },
        { partyId: 'party-owner', relation: 'owner' },
      ]);
    });

    it('找不到屋主的自管案件時，沒有 owner 成員（ADR-0023 後果）', () => {
      const { members } = accepted(decideCaseCreation(masterLease({ ownerPartyId: null }), NOW));
      expect(members).toEqual([{ partyId: 'party-pm', relation: 'lessor' }]);
    });

    it('只有包租案件才加 owner 成員', () => {
      const { members } = accepted(decideCaseCreation(managedLease({ ownerPartyId: 'party-owner' }), NOW));
      expect(members.map((m) => m.relation)).toEqual(['lessor']);
    });
  });

  it('lessor 的 party ID 是空字串 → 擋下', () => {
    expect(reasonCodes(decideCaseCreation(newLease({ lessorPartyId: ' ' }), NOW))).toEqual(['invalid_party']);
  });
});

describe('decideCaseCreation：新委託管理案件', () => {
  it('draft、沒有租賃單位，mandator 與 mandatary 成員（ADR-0023 決議 5）', () => {
    expect(decideCaseCreation(newMandate(), NOW)).toEqual({
      ok: true,
      case: {
        kind: 'management',
        id: 'mcase-1',
        orgId: 'org-pm',
        state: 'draft',
        stateVersion: 0,
        currentContractId: null,
        validUntil: '2027-11-07',
      },
      members: [
        { partyId: 'party-owner', relation: 'mandator' },
        { partyId: 'party-pm', relation: 'mandatary' },
      ],
      event: {
        type: 'created',
        occurredAt: NOW_ISO,
        payload: { kind: 'management', validUntil: '2027-11-07' },
      },
    });
  });

  it('期限未定：validUntil 可以是 null', () => {
    const result = accepted(decideCaseCreation(newMandate({ validUntil: null }), NOW));
    expect(result.case).toMatchObject({ validUntil: null });
  });

  it('不檢查主辦組織種類（屋主上傳紙本契約書時主辦組織不確定）', () => {
    const owner = newMandate({ hostOrg: { orgId: 'org-owner', kind: 'owner' } });
    expect(decideCaseCreation(owner, NOW).ok).toBe(true);
  });

  it('mandator 與 mandatary 是同一個人 → 擋下', () => {
    const result = decideCaseCreation(newMandate({ mandataryPartyId: 'party-owner' }), NOW);
    expect(reasonCodes(result)).toEqual(['mandator_equals_mandatary']);
  });

  it.each([
    ['mandatorPartyId', ''],
    ['mandataryPartyId', '  '],
  ] as const)('%s 是空白 → 擋下', (field, value) => {
    expect(reasonCodes(decideCaseCreation(newMandate({ [field]: value }), NOW))).toEqual(['invalid_party']);
  });

  it.each(['2027-13-01', '2027-02-30', '2027/11/07', '20271107', '2027-1-7', ''])(
    'validUntil %j 不是有效的 YYYY-MM-DD → 擋下',
    (validUntil) => {
      expect(reasonCodes(decideCaseCreation(newMandate({ validUntil }), NOW))).toEqual(['invalid_valid_until']);
    },
  );

  it('建立出來的 draft 案件接得上 decideCaseTransition：上傳紙本契約書進 active', () => {
    const { case: created } = accepted(decideCaseCreation(newMandate(), NOW));
    const next = decideCaseTransition(
      { kind: 'management', id: created.id, state: 'draft', stateVersion: 0, currentContractId: null, validUntil: '2027-11-07' },
      { type: 'register_paper_contract', documentId: 'doc-1' },
      NOW,
    );
    expect(next?.state).toBe('active');
  });
});

describe('decideCaseCreation：後繼案件（ADR-0024 決議 2 到 4）', () => {
  it('接收方是新受託人：managed、直接 active、沒有合約、記移交包 ID', () => {
    expect(decideCaseCreation(successor(), NOW)).toEqual({
      ok: true,
      case: {
        kind: 'lease',
        id: 'case-2',
        orgId: 'org-pm-2',
        state: 'active',
        stateVersion: 0,
        currentContractId: null,
        businessType: 'managed',
        rentalUnitId: 'unit-1',
        linkedMandateCaseId: null,
        predecessorCaseId: 'case-1',
        handoverId: 'ho-1',
      },
      members: [
        { partyId: 'party-owner', relation: 'lessor' },
        { partyId: 'party-lessee', relation: 'lessee' },
      ],
      event: {
        type: 'succeeded',
        occurredAt: NOW_ISO,
        payload: {
          kind: 'lease',
          businessType: 'managed',
          rentalUnitId: 'unit-1',
          predecessorCaseId: 'case-1',
          handoverId: 'ho-1',
        },
      },
    });
  });

  it('改自管：接收方是屋主組織，業務類型 self_managed', () => {
    const result = accepted(
      decideCaseCreation(successor({ receiverOrg: { orgId: 'org-owner', kind: 'owner' }, businessType: 'self_managed' }), NOW),
    );
    expect(result.case).toMatchObject({ orgId: 'org-owner', businessType: 'self_managed', state: 'active' });
  });

  it('承租人與共同承租人都帶過來，相同 party 只留一筆', () => {
    const { members } = accepted(
      decideCaseCreation(
        successor({ lesseePartyIds: ['p-1', 'p-1'], coLesseePartyIds: ['p-2', 'p-2', 'p-3'] }),
        NOW,
      ),
    );
    expect(members).toEqual([
      { partyId: 'party-owner', relation: 'lessor' },
      { partyId: 'p-1', relation: 'lessee' },
      { partyId: 'p-2', relation: 'co_lessee' },
      { partyId: 'p-3', relation: 'co_lessee' },
    ]);
  });

  it('租賃單位沒有承租人（空置）：只有 lessor 成員', () => {
    const { members } = accepted(decideCaseCreation(successor({ lesseePartyIds: [] }), NOW));
    expect(members).toEqual([{ partyId: 'party-owner', relation: 'lessor' }]);
  });

  it.each([
    ['owner', 'self_managed', true],
    ['owner', 'managed', false],
    ['owner', 'master_lease', false],
    ['practice', 'managed', true],
    ['practice', 'self_managed', false],
    ['practice', 'master_lease', false],
  ] as const)('接收方 %s 組織、業務類型 %s：允許 %s（移交只適用代管，結果只會是代管或自管）', (kind, businessType, allowed) => {
    const result = decideCaseCreation(successor({ receiverOrg: { orgId: 'org-x', kind }, businessType }), NOW);
    expect(result.ok).toBe(allowed);
    if (!allowed) expect(reasonCodes(result)).toEqual(['business_type_not_allowed']);
  });

  it('接收方檢查不重複 F 線的擋下條件：不需要委託與執業主體事實', () => {
    // SuccessorCaseInput 沒有 mandateCase、practice 欄位，委託與驗證由 checkHandoverPreconditions 負責
    expect(decideCaseCreation(successor(), NOW).ok).toBe(true);
  });

  it('承租人的 party ID 是空白 → 擋下', () => {
    expect(reasonCodes(decideCaseCreation(successor({ lesseePartyIds: ['  '] }), NOW))).toEqual(['invalid_party']);
  });

  it('後繼案件是 active，接得上 decideCaseTransition：可發起退租', () => {
    const { case: created } = accepted(decideCaseCreation(successor(), NOW));
    const next = decideCaseTransition(
      { kind: 'lease', id: created.id, state: 'active', stateVersion: 0, businessType: 'managed', currentContractId: null },
      { type: 'start_move_out' },
      NOW,
    );
    expect(next?.state).toBe('move_out');
  });

  it('後繼案件沒有合約，合約輸入一律不接受', () => {
    const snapshot = { kind: 'lease', id: 'case-2', state: 'active', stateVersion: 0, businessType: 'managed', currentContractId: null } as const;
    expect(decideCaseTransition(snapshot, { type: 'contract_completed', contractId: 'contract-1' }, NOW)).toBeNull();
  });
});

describe('decideCaseCreation：共通', () => {
  const inputs: [string, CaseCreationInput][] = [
    ['新租賃案件', newLease()],
    ['新委託管理案件', newMandate()],
    ['後繼案件', successor()],
  ];

  it.each(inputs)('%s：時間取自參數，不讀系統時鐘', (_name, input) => {
    const a = accepted(decideCaseCreation(input, new Date('2030-01-01T00:00:00Z')));
    expect(a.event.occurredAt).toBe('2030-01-01T00:00:00.000Z');
  });

  it.each(inputs)('%s：初始 stateVersion 是 0，沒有 current_contract_id', (_name, input) => {
    const { case: created } = accepted(decideCaseCreation(input, NOW));
    expect(created.stateVersion).toBe(0);
    expect(created.currentContractId).toBeNull();
  });

  it.each(inputs)('%s：不修改傳入的輸入', (_name, input) => {
    const copy = structuredClone(input);
    decideCaseCreation(input, NOW);
    expect(input).toEqual(copy);
  });
});
