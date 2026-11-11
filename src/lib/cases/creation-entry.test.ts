import { describe, expect, it } from 'vitest';
import { availableCaseKinds, businessTypeForNewCase, practiceFactsFor, type CaseEntryFacts, type PracticeEligibility } from './creation';

// 「這個物件能建哪些案件」的純函式（MIL-209，ADR-0030 決議 1、5）。
// 判斷與 decideCaseCreation 同一組規則，所以入口列出的種類，伺服端建立時一定放行。

const READY: PracticeEligibility = {
  licenses: { management: 'verified', master_lease: 'verified' },
  hasSignableManager: true,
};

const OWNER: CaseEntryFacts = {
  orgId: 'org-1',
  orgKind: 'owner',
  verified: true,
  practice: null,
  masterLeaseCase: null,
  mandateCase: null,
};

const PRACTICE: CaseEntryFacts = { ...OWNER, orgKind: 'practice', practice: READY };

const ACTIVE_MASTER_LEASE = { id: 'ml-1', orgId: 'org-1', state: 'active', coversRentalUnit: true } as const;
const ACTIVE_MANDATE = { id: 'mg-1', state: 'active', coversRentalUnit: true } as const;

describe('availableCaseKinds', () => {
  it('物件沒有通過核對：任何組織都是空陣列', () => {
    expect(availableCaseKinds({ ...OWNER, verified: false })).toEqual([]);
    expect(availableCaseKinds({ ...PRACTICE, verified: false, masterLeaseCase: ACTIVE_MASTER_LEASE })).toEqual([]);
  });

  it('屋主組織：只能建租賃案件', () => {
    expect(availableCaseKinds(OWNER)).toEqual(['lease']);
  });

  it('執業主體組織沒有上層案件：只能建包租案件', () => {
    expect(availableCaseKinds(PRACTICE)).toEqual(['master_lease']);
  });

  it('自家有效的包租案件涵蓋這個物件：多出轉租案件', () => {
    expect(availableCaseKinds({ ...PRACTICE, masterLeaseCase: ACTIVE_MASTER_LEASE })).toEqual(['master_lease', 'sublease']);
  });

  it('包租案件不是自家的或不是 active：沒有轉租案件', () => {
    expect(availableCaseKinds({ ...PRACTICE, masterLeaseCase: { ...ACTIVE_MASTER_LEASE, orgId: 'org-2' } })).toEqual(['master_lease']);
    expect(availableCaseKinds({ ...PRACTICE, masterLeaseCase: { ...ACTIVE_MASTER_LEASE, state: 'draft' } })).toEqual(['master_lease']);
  });

  it('自家有效的委託管理案件涵蓋這個物件：多出代管的租賃案件', () => {
    expect(availableCaseKinds({ ...PRACTICE, mandateCase: ACTIVE_MANDATE })).toEqual(['lease', 'master_lease']);
  });

  it('業別沒有通過驗證：該業別的案件不列出', () => {
    const noMasterLease: PracticeEligibility = { ...READY, licenses: { management: 'verified', master_lease: 'pending' } };
    expect(availableCaseKinds({ ...PRACTICE, practice: noMasterLease, masterLeaseCase: ACTIVE_MASTER_LEASE, mandateCase: ACTIVE_MANDATE })).toEqual(['lease']);
    const noManagement: PracticeEligibility = { ...READY, licenses: { management: null, master_lease: 'verified' } };
    expect(availableCaseKinds({ ...PRACTICE, practice: noManagement, mandateCase: ACTIVE_MANDATE })).toEqual(['master_lease']);
  });

  it('沒有可簽章的專任管理人員：執業主體組織什麼都不能建', () => {
    expect(availableCaseKinds({ ...PRACTICE, practice: { ...READY, hasSignableManager: false }, masterLeaseCase: ACTIVE_MASTER_LEASE })).toEqual([]);
  });

  it('執業主體組織沒有載入資格事實：什麼都不能建', () => {
    expect(availableCaseKinds({ ...PRACTICE, practice: null })).toEqual([]);
  });
});

describe('businessTypeForNewCase', () => {
  it('租賃案件：屋主組織是自管，執業主體組織是代管', () => {
    expect(businessTypeForNewCase('owner', 'lease')).toBe('self_managed');
    expect(businessTypeForNewCase('practice', 'lease')).toBe('managed');
  });

  it('包租案件是自管的業務類型，轉租案件是舊值 master_lease，只有執業主體組織能建', () => {
    expect(businessTypeForNewCase('practice', 'master_lease')).toBe('self_managed');
    expect(businessTypeForNewCase('practice', 'sublease')).toBe('master_lease');
    expect(businessTypeForNewCase('owner', 'master_lease')).toBeNull();
    expect(businessTypeForNewCase('owner', 'sublease')).toBeNull();
  });
});

describe('practiceFactsFor', () => {
  it('租賃（代管）看代管業別，包租與轉租看包租業別', () => {
    const mixed: PracticeEligibility = { licenses: { management: 'verified', master_lease: 'lapsed' }, hasSignableManager: true };
    expect(practiceFactsFor('lease', mixed)).toEqual({ entityStatus: 'verified', hasSignableManager: true });
    expect(practiceFactsFor('master_lease', mixed)).toEqual({ entityStatus: 'lapsed', hasSignableManager: true });
    expect(practiceFactsFor('sublease', mixed)).toEqual({ entityStatus: 'lapsed', hasSignableManager: true });
  });
});
