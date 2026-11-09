import { describe, expect, it } from 'vitest';
import {
  LEASE_CASE_STATES,
  MANAGEMENT_CASE_STATES,
  type BusinessType,
  type CaseKind,
  type CaseMemberRelation,
  type CaseState,
  type LeaseCaseState,
  type ManagementCaseState,
} from '../cases';
import {
  ACTIONS,
  ACTION_IDS,
  actionForUncasedObject,
  decideAccess,
  type AccessFacts,
  type ActionId,
  type OnBehalfFacts,
  type OrgRole,
} from './index';

// 預期值來自 PRD P0-09 權限表、ADR-0016 決議 7、ADR-0023 決議 5 到 7 的人工對照，
// 不從 ACTIONS 推導，避免測試與實作同步出錯。

const FULL_MANDATE: OnBehalfFacts = {
  mandateCaseActive: true,
  rentalUnitInMandate: true,
  mandateScopes: ['rent_collection', 'deposit_management', 'repair', 'inspection'],
  practiceEntityVerified: true,
  hasSignableManager: true,
};

interface Persona {
  id: string;
  kind: CaseKind;
  make: (state: CaseState) => AccessFacts;
}

interface PersonaOpts {
  role: OrgRole | null;
  host: boolean;
  relations: CaseMemberRelation[];
}

function leasePersona(id: string, businessType: BusinessType, opts: PersonaOpts): Persona {
  return {
    id,
    kind: 'lease',
    make: (state) => ({
      orgRole: opts.role,
      caseFacts: {
        kind: 'lease',
        state: state as LeaseCaseState,
        businessType,
        isHostOrgMember: opts.host,
        relations: opts.relations,
        onBehalf: businessType === 'managed' ? FULL_MANDATE : null,
      },
    }),
  };
}

function mgmtPersona(id: string, opts: PersonaOpts): Persona {
  return {
    id,
    kind: 'management',
    make: (state) => ({
      orgRole: opts.role,
      caseFacts: {
        kind: 'management',
        state: state as ManagementCaseState,
        isHostOrgMember: opts.host,
        relations: opts.relations,
      },
    }),
  };
}

const VARIANTS = [
  ['self', 'self_managed'],
  ['managed', 'managed'],
  ['master', 'master_lease'],
] as const;

const PERSONAS: Persona[] = [
  ...VARIANTS.flatMap(([prefix, bt]) => [
    leasePersona(`${prefix}.host_admin`, bt, { role: 'admin', host: true, relations: [] }),
    leasePersona(`${prefix}.host_staff`, bt, { role: 'staff', host: true, relations: [] }),
    leasePersona(`${prefix}.host_viewer`, bt, { role: 'viewer', host: true, relations: [] }),
    leasePersona(`${prefix}.lessee`, bt, { role: null, host: false, relations: ['lessee'] }),
    leasePersona(`${prefix}.practitioner`, bt, { role: 'staff', host: false, relations: ['practitioner'] }),
    leasePersona(`${prefix}.broker`, bt, { role: 'staff', host: false, relations: ['broker'] }),
    leasePersona(`${prefix}.stranger`, bt, { role: 'admin', host: false, relations: [] }),
  ]),
  // 出租人關係：自管是出租人、代管是屋主、包租是包租業者
  leasePersona('self.lessor', 'self_managed', { role: 'admin', host: false, relations: ['lessor'] }),
  leasePersona('self.co_lessee', 'self_managed', { role: null, host: false, relations: ['co_lessee'] }),
  leasePersona('managed.owner', 'managed', { role: 'staff', host: false, relations: ['lessor'] }),
  leasePersona('managed.owner_viewer', 'managed', { role: 'viewer', host: false, relations: ['lessor'] }),
  leasePersona('master.lessor', 'master_lease', { role: 'admin', host: false, relations: ['lessor'] }),
  leasePersona('master.owner', 'master_lease', { role: 'staff', host: false, relations: ['owner'] }),
  mgmtPersona('mgmt.host_admin', { role: 'admin', host: true, relations: [] }),
  mgmtPersona('mgmt.host_staff', { role: 'staff', host: true, relations: [] }),
  mgmtPersona('mgmt.host_viewer', { role: 'viewer', host: true, relations: [] }),
  mgmtPersona('mgmt.mandator', { role: 'staff', host: false, relations: ['mandator'] }),
  mgmtPersona('mgmt.mandatary', { role: 'staff', host: false, relations: ['mandatary'] }),
  mgmtPersona('mgmt.stranger', { role: 'admin', host: false, relations: [] }),
];

const hostWriters = (...prefixes: string[]) => prefixes.flatMap((p) => [`${p}.host_admin`, `${p}.host_staff`]);
const hostReaders = (...prefixes: string[]) =>
  prefixes.flatMap((p) => [`${p}.host_admin`, `${p}.host_staff`, `${p}.host_viewer`]);

const ALL_LEASE_STATES: CaseState[] = [...LEASE_CASE_STATES];
const ALL_MGMT_STATES: CaseState[] = [...MANAGEMENT_CASE_STATES];
const OPERATING: CaseState[] = ['active', 'move_out', 'settling'];
const OPEN_LEASE: CaseState[] = ['draft', 'signing', 'active', 'move_out', 'settling'];

const NOT_STRANGER = PERSONAS.map((p) => p.id).filter((id) => !id.endsWith('.stranger'));

interface Expectation {
  /** 允許該動作的 persona。 */
  personas: string[];
  states: { lease: CaseState[]; management: CaseState[] };
}

const CONTRACT_OPERATORS = [...hostWriters('self', 'managed', 'master', 'mgmt'), 'self.lessor', 'master.lessor'];

const CASE_EXPECTATIONS: Record<string, Expectation> = {
  // 讀租期與狀態：所有成員，含包租案件的所有權人
  'case.read_summary': {
    personas: NOT_STRANGER,
    states: { lease: ALL_LEASE_STATES, management: ALL_MGMT_STATES },
  },
  // 讀合約：除了包租案件的所有權人
  'contract.read': {
    personas: NOT_STRANGER.filter((id) => id !== 'master.owner'),
    states: { lease: ALL_LEASE_STATES, management: ALL_MGMT_STATES },
  },
  // 讀帳務：不含經紀業者、簽章人員、所有權人
  'ledger.read': {
    personas: [
      ...hostReaders('self', 'managed', 'master'),
      'self.lessor',
      'managed.owner',
      'managed.owner_viewer',
      'master.lessor',
      'self.lessee',
      'self.co_lessee',
      'managed.lessee',
      'master.lessee',
    ],
    states: { lease: ALL_LEASE_STATES, management: [] },
  },
  // 屋主報表：自己的、自己產出的。包租業者否，所有權人是
  'report.read_owner': {
    personas: [...hostReaders('self', 'managed'), 'self.lessor', 'managed.owner', 'managed.owner_viewer', 'master.owner'],
    states: { lease: ALL_LEASE_STATES, management: [] },
  },
  // 擬約與送簽：代管案件的屋主否，承租人否
  'contract.draft_send': {
    personas: CONTRACT_OPERATORS,
    states: { lease: ['draft'], management: ['draft'] },
  },
  'ledger.record_payment': {
    personas: [...hostWriters('self', 'managed', 'master'), 'self.lessor', 'master.lessor'],
    states: { lease: OPERATING, management: [] },
  },
  'ledger.record_deposit': {
    personas: [...hostWriters('self', 'managed', 'master'), 'self.lessor', 'master.lessor'],
    states: { lease: OPERATING, management: [] },
  },
  'ledger.send_overdue_reminder': {
    personas: [...hostWriters('self', 'managed', 'master'), 'self.lessor', 'master.lessor'],
    states: { lease: OPERATING, management: [] },
  },
  // 修繕：代管案件的屋主是，承租人限報修
  'repair.manage': {
    personas: [...hostWriters('self', 'managed', 'master'), 'self.lessor', 'managed.owner', 'master.lessor'],
    states: { lease: OPERATING, management: [] },
  },
  'repair.report': {
    personas: ['self.lessee', 'self.co_lessee', 'managed.lessee', 'master.lessee'],
    states: { lease: OPERATING, management: [] },
  },
  // 確認點交：出租人、屋主、業者、承租人皆是，所有權人否
  'inspection.confirm': {
    personas: [
      ...hostWriters('self', 'managed', 'master'),
      'self.lessor',
      'managed.owner',
      'master.lessor',
      'self.lessee',
      'self.co_lessee',
      'managed.lessee',
      'master.lessee',
    ],
    states: { lease: ['active', 'move_out'], management: [] },
  },
  // 發起退租：承租人無此權限（ADR-0016 決議 7）
  'move_out.start': {
    personas: [...hostWriters('self', 'managed', 'master'), 'self.lessor', 'managed.owner', 'master.lessor'],
    states: { lease: ['active'], management: [] },
  },
  // 對押金扣抵標示異議：只有承租人
  'deposit.dispute': {
    personas: ['self.lessee', 'self.co_lessee', 'managed.lessee', 'master.lessee'],
    states: { lease: ['move_out', 'settling'], management: [] },
  },
  // 發起移交：只適用代管租賃案件與它連結的委託管理案件（ADR-0024 決議 1）
  'handover.initiate': {
    personas: [...hostWriters('managed', 'mgmt'), 'managed.owner', 'mgmt.mandator', 'mgmt.mandatary'],
    states: { lease: OPERATING, management: ['active'] },
  },
  // 合約生命週期動作（MIL-108）：與擬約送簽同一批人，只差允許的案件狀態。
  // 撤回與拒簽後案件回 draft（cases README），所以複製為新草稿在 draft。
  'contract.void': {
    personas: CONTRACT_OPERATORS,
    states: { lease: ['signing'], management: ['signing'] },
  },
  'contract.copy': {
    personas: CONTRACT_OPERATORS,
    states: { lease: ['draft'], management: ['draft'] },
  },
  'contract.resend': {
    personas: CONTRACT_OPERATORS,
    states: { lease: ['signing'], management: ['signing'] },
  },
  'contract.sign_link': {
    personas: CONTRACT_OPERATORS,
    states: { lease: ['signing'], management: ['signing'] },
  },
  'contract.refetch_files': {
    personas: CONTRACT_OPERATORS,
    states: { lease: ['signing', 'active'], management: ['signing', 'active'] },
  },
  'contract.simulate_signing': {
    personas: CONTRACT_OPERATORS,
    states: { lease: ['signing'], management: ['signing'] },
  },
  // 成員管理（案件層）：主辦組織 admin、staff（ADR-0023 決議 5）
  'case_member.manage': {
    personas: hostWriters('self', 'managed', 'master', 'mgmt'),
    states: { lease: OPEN_LEASE, management: ['draft', 'signing', 'active'] },
  },
};

const ORG_EXPECTATIONS: Record<string, { roles: OrgRole[] }> = {
  'org_member.manage': { roles: ['admin'] },
  'audit.export': { roles: ['admin'] },
  // 組織成員列表：所有角色（待處理邀請的過濾由載入資料的人負責）
  'org_member.read': { roles: ['admin', 'staff', 'viewer'] },
  // 物件在組織層，沒有案件：讀取所有角色，寫入 viewer 被拒（MIL-108 剩餘範圍）
  'property.read': { roles: ['admin', 'staff', 'viewer'] },
  'property.manage': { roles: ['admin', 'staff'] },
  // 案件清單（MIL-115）：所有角色可讀
  'case.list': { roles: ['admin', 'staff', 'viewer'] },
  // 還沒歸屬案件的合約（MIL-115 遷移前）：依組織角色
  'uncased_contract.read': { roles: ['admin', 'staff', 'viewer'] },
  'uncased_contract.write': { roles: ['admin', 'staff'] },
  // 執業主體端（MIL-109）：看進度與批次查詢所有角色，送件與補件 viewer 被拒
  'practice_registry.read': { roles: ['admin', 'staff', 'viewer'] },
  'practice_registry.submit': { roles: ['admin', 'staff'] },
  'practice_entity.lookup': { roles: ['admin', 'staff', 'viewer'] },
};

function persona(id: string): Persona {
  const found = PERSONAS.find((p) => p.id === id);
  if (!found) throw new Error(`unknown persona ${id}`);
  return found;
}

describe('decideAccess 全矩陣：案件動作乘 persona 乘案件狀態', () => {
  it('動作表涵蓋的動作與測試預期一一對應', () => {
    expect([...ACTION_IDS].sort()).toEqual(
      [...Object.keys(CASE_EXPECTATIONS), ...Object.keys(ORG_EXPECTATIONS)].sort(),
    );
  });

  const rows = Object.entries(CASE_EXPECTATIONS).flatMap(([action, exp]) =>
    PERSONAS.map((p) => [action, p.id, exp, p] as const),
  );

  it.each(rows)('%s × %s', (action, personaId, exp, p) => {
    const states = p.kind === 'lease' ? ALL_LEASE_STATES : ALL_MGMT_STATES;
    const allowedStates = p.kind === 'lease' ? exp.states.lease : exp.states.management;
    const isGrantee = exp.personas.includes(personaId);
    for (const state of states) {
      const decision = decideAccess(p.make(state), action as ActionId);
      const expected = isGrantee && allowedStates.includes(state);
      expect(decision.allowed, `${action} / ${personaId} / ${state}`).toBe(expected);
    }
  });
});

describe('decideAccess 組織層動作', () => {
  const caseFacts = persona('self.host_admin').make('active').caseFacts;
  const roles: (OrgRole | null)[] = ['admin', 'staff', 'viewer', null];

  it.each(Object.entries(ORG_EXPECTATIONS).flatMap(([action, e]) => roles.map((r) => [action, e, r] as const)))(
    '%s × 角色 %s',
    (action, e, role) => {
      for (const facts of [
        { orgRole: role, caseFacts: null },
        { orgRole: role, caseFacts },
      ]) {
        const decision = decideAccess(facts, action as ActionId);
        expect(decision.allowed).toBe(role !== null && e.roles.includes(role));
      }
    },
  );

  it('沒有組織脈絡（承租人、平台營運者）回 no_org_context', () => {
    expect(decideAccess({ orgRole: null, caseFacts: null }, 'audit.export')).toEqual({
      allowed: false,
      reason: 'no_org_context',
    });
  });

  it('staff 匯出稽核紀錄回 role_not_allowed', () => {
    expect(decideAccess({ orgRole: 'staff', caseFacts: null }, 'audit.export')).toEqual({
      allowed: false,
      reason: 'role_not_allowed',
    });
  });

  it('viewer 管理成員回 viewer_read_only', () => {
    expect(decideAccess({ orgRole: 'viewer', caseFacts: null }, 'org_member.manage')).toEqual({
      allowed: false,
      reason: 'viewer_read_only',
    });
  });

  it('admin 匯出稽核紀錄允許，路徑是 org_role', () => {
    expect(decideAccess({ orgRole: 'admin', caseFacts: null }, 'audit.export')).toEqual({
      allowed: true,
      via: 'org_role',
      onBehalf: false,
    });
  });
});

describe('decideAccess 拒絕原因', () => {
  it('非成員回 not_a_member，不分案件動作', () => {
    for (const action of ACTION_IDS.filter((a) => !(a in ORG_EXPECTATIONS))) {
      expect(decideAccess(persona('managed.stranger').make('active'), action)).toEqual({
        allowed: false,
        reason: 'not_a_member',
      });
    }
  });

  it('案件動作沒有案件事實回 no_case', () => {
    expect(decideAccess({ orgRole: 'admin', caseFacts: null }, 'contract.read')).toEqual({
      allowed: false,
      reason: 'no_case',
    });
  });

  it('是成員但關係沒有該動作回 not_granted', () => {
    expect(decideAccess(persona('self.lessee').make('draft'), 'contract.draft_send')).toEqual({
      allowed: false,
      reason: 'not_granted',
    });
    expect(decideAccess(persona('master.owner').make('active'), 'contract.read')).toEqual({
      allowed: false,
      reason: 'not_granted',
    });
  });

  it('viewer 寫入回 viewer_read_only，主辦組織與案件成員兩條路徑都擋', () => {
    expect(decideAccess(persona('self.host_viewer').make('draft'), 'contract.draft_send')).toEqual({
      allowed: false,
      reason: 'viewer_read_only',
    });
    expect(decideAccess(persona('managed.owner_viewer').make('active'), 'repair.manage')).toEqual({
      allowed: false,
      reason: 'viewer_read_only',
    });
  });

  it('viewer 讀取允許', () => {
    expect(decideAccess(persona('self.host_viewer').make('active'), 'contract.read').allowed).toBe(true);
  });

  it('終態的寫入回 case_closed_read_only，讀取仍允許', () => {
    for (const state of ['closed', 'aborted'] as const) {
      expect(decideAccess(persona('self.host_admin').make(state), 'ledger.record_payment')).toEqual({
        allowed: false,
        reason: 'case_closed_read_only',
      });
      expect(decideAccess(persona('self.lessee').make(state), 'deposit.dispute')).toEqual({
        allowed: false,
        reason: 'case_closed_read_only',
      });
      expect(decideAccess(persona('self.lessee').make(state), 'contract.read').allowed).toBe(true);
    }
    for (const state of ['terminated', 'expired', 'aborted'] as const) {
      expect(decideAccess(persona('mgmt.host_admin').make(state), 'case_member.manage')).toEqual({
        allowed: false,
        reason: 'case_closed_read_only',
      });
      expect(decideAccess(persona('mgmt.mandator').make(state), 'contract.read').allowed).toBe(true);
    }
  });

  it('非終態但不在動作的允許狀態回 state_not_allowed', () => {
    expect(decideAccess(persona('self.host_admin').make('active'), 'contract.draft_send')).toEqual({
      allowed: false,
      reason: 'state_not_allowed',
    });
  });

  it('不存在的動作回 unknown_action，原型鏈名稱也一樣', () => {
    for (const action of ['no.such_action', 'toString', '__proto__', 'constructor']) {
      expect(decideAccess(persona('self.host_admin').make('active'), action as ActionId)).toEqual({
        allowed: false,
        reason: 'unknown_action',
      });
    }
  });
});

describe('decideAccess 允許結果的路徑與代操作旗標', () => {
  it('主辦組織成員走 host_org，案件成員走 case_relation', () => {
    expect(decideAccess(persona('self.host_staff').make('active'), 'contract.read')).toEqual({
      allowed: true,
      via: 'host_org',
      onBehalf: false,
    });
    expect(decideAccess(persona('self.lessee').make('active'), 'contract.read')).toEqual({
      allowed: true,
      via: 'case_relation',
      onBehalf: false,
    });
  });

  it('代管業者的代操作動作標示 onBehalf，屋主與其他動作不標示', () => {
    expect(decideAccess(persona('managed.host_staff').make('active'), 'repair.manage')).toEqual({
      allowed: true,
      via: 'host_org',
      onBehalf: true,
    });
    expect(decideAccess(persona('managed.owner').make('active'), 'repair.manage')).toEqual({
      allowed: true,
      via: 'case_relation',
      onBehalf: false,
    });
    expect(decideAccess(persona('managed.host_staff').make('draft'), 'contract.draft_send')).toEqual({
      allowed: true,
      via: 'host_org',
      onBehalf: false,
    });
  });

  it('同時是主辦組織成員與案件成員時，任一條路徑通過就允許', () => {
    const base = persona('self.host_staff').make('active').caseFacts;
    if (base === null || base.kind !== 'lease') throw new Error('unreachable');
    const mixed: AccessFacts = {
      orgRole: 'staff',
      caseFacts: { ...base, isHostOrgMember: true, relations: ['lessee'] },
    };
    expect(decideAccess(mixed, 'ledger.record_payment')).toMatchObject({ allowed: true, via: 'host_org' });
    expect(decideAccess(mixed, 'repair.report')).toMatchObject({ allowed: true, via: 'case_relation' });
  });
});

describe('decideAccess 代操作四個條件（ADR-0023 決議 7）', () => {
  const ON_BEHALF_ACTIONS = [
    ['ledger.record_payment', 'rent_collection'],
    ['ledger.send_overdue_reminder', 'rent_collection'],
    ['ledger.record_deposit', 'deposit_management'],
    ['repair.manage', 'repair'],
    ['inspection.confirm', 'inspection'],
    ['move_out.start', 'inspection'],
  ] as const;

  const managedHost = (onBehalf: OnBehalfFacts | null, state: CaseState = 'active'): AccessFacts => ({
    orgRole: 'staff',
    caseFacts: {
      kind: 'lease',
      state: state as 'active',
      businessType: 'managed',
      isHostOrgMember: true,
      relations: [],
      onBehalf,
    },
  });

  it('四個條件都成立時允許，並標示 onBehalf', () => {
    for (const [action] of ON_BEHALF_ACTIONS) {
      expect(decideAccess(managedHost(FULL_MANDATE), action)).toEqual({
        allowed: true,
        via: 'host_org',
        onBehalf: true,
      });
    }
  });

  const failures: [string, Partial<OnBehalfFacts>, string][] = [
    ['條件 1：委託管理案件不是 active', { mandateCaseActive: false }, 'mandate_not_active'],
    ['條件 2：租賃單位不在委託標的清單', { rentalUnitInMandate: false }, 'unit_not_in_mandate'],
    ['條件 4：業別不是 verified', { practiceEntityVerified: false }, 'practice_not_verified'],
    ['條件 4：沒有可簽章的專任管理人員', { hasSignableManager: false }, 'no_signable_manager'],
  ];

  it.each(
    failures.flatMap(([name, patch, reason]) => ON_BEHALF_ACTIONS.map(([a]) => [name, a, patch, reason] as const)),
  )('%s × %s', (_name, action, patch, reason) => {
    expect(decideAccess(managedHost({ ...FULL_MANDATE, ...patch }), action)).toEqual({ allowed: false, reason });
  });

  it.each(ON_BEHALF_ACTIONS)('條件 3：%s 需要委託範圍 %s，缺少時拒絕', (action, scope) => {
    const others = FULL_MANDATE.mandateScopes.filter((s) => s !== scope);
    expect(decideAccess(managedHost({ ...FULL_MANDATE, mandateScopes: others }), action)).toEqual({
      allowed: false,
      reason: 'scope_not_covered',
    });
    expect(decideAccess(managedHost({ ...FULL_MANDATE, mandateScopes: [scope] }), action).allowed).toBe(true);
    expect(decideAccess(managedHost({ ...FULL_MANDATE, mandateScopes: [] }), action)).toEqual({
      allowed: false,
      reason: 'scope_not_covered',
    });
  });

  it('沒有連結的委託管理案件（onBehalf 是 null）回 no_mandate_link', () => {
    for (const [action] of ON_BEHALF_ACTIONS) {
      expect(decideAccess(managedHost(null), action)).toEqual({ allowed: false, reason: 'no_mandate_link' });
    }
  });

  it('PRD AC4：委託範圍不含押金管理時，登錄押金分錄被拒，入帳確認不受影響', () => {
    const facts = managedHost({ ...FULL_MANDATE, mandateScopes: ['rent_collection', 'repair', 'inspection'] });
    expect(decideAccess(facts, 'ledger.record_deposit')).toEqual({ allowed: false, reason: 'scope_not_covered' });
    expect(decideAccess(facts, 'ledger.record_payment').allowed).toBe(true);
  });

  it('非代操作的動作不查委託：擬約送簽與讀取在 onBehalf 是 null 時仍允許', () => {
    expect(decideAccess(managedHost(null, 'draft'), 'contract.draft_send').allowed).toBe(true);
    expect(decideAccess(managedHost(null), 'contract.read').allowed).toBe(true);
    expect(decideAccess(managedHost(null), 'case_member.manage').allowed).toBe(true);
  });

  it('代操作條件只適用代管案件的主辦組織，自管與包租的主辦組織不查', () => {
    for (const businessType of ['self_managed', 'master_lease'] as const) {
      const facts: AccessFacts = {
        orgRole: 'staff',
        caseFacts: { kind: 'lease', state: 'active', businessType, isHostOrgMember: true, relations: [], onBehalf: null },
      };
      expect(decideAccess(facts, 'ledger.record_deposit')).toEqual({ allowed: true, via: 'host_org', onBehalf: false });
    }
  });

  it('條件不成立時，屋主（lessor 關係）的修繕與確認點交不受影響', () => {
    const owner: AccessFacts = {
      orgRole: 'staff',
      caseFacts: {
        kind: 'lease',
        state: 'active',
        businessType: 'managed',
        isHostOrgMember: false,
        relations: ['lessor'],
        onBehalf: { ...FULL_MANDATE, mandateCaseActive: false },
      },
    };
    expect(decideAccess(owner, 'repair.manage').allowed).toBe(true);
    expect(decideAccess(owner, 'inspection.confirm').allowed).toBe(true);
  });

  it('結案後即使條件都成立，代操作的寫入仍被拒', () => {
    expect(decideAccess(managedHost(FULL_MANDATE, 'closed'), 'ledger.record_payment')).toEqual({
      allowed: false,
      reason: 'case_closed_read_only',
    });
  });
});

describe('動作表本身', () => {
  it('每個案件寫入動作都有明確的允許狀態，且不含終態', () => {
    const terminal = ['closed', 'aborted', 'terminated', 'expired'];
    for (const id of ACTION_IDS) {
      const rule = ACTIONS[id];
      if (rule.scope === 'case' && rule.effect === 'write') {
        expect(rule.states.length).toBeGreaterThan(0);
        expect(rule.states.some((s) => terminal.includes(s))).toBe(false);
      }
    }
  });

  it('標為代操作的動作正好是 ADR-0023 決議 7 列出的六個', () => {
    const onBehalfActions = ACTION_IDS.filter((id) => {
      const rule = ACTIONS[id];
      return rule.scope === 'case' && rule.onBehalfScope !== null;
    });
    expect([...onBehalfActions].sort()).toEqual(
      [
        'inspection.confirm',
        'ledger.record_deposit',
        'ledger.record_payment',
        'ledger.send_overdue_reminder',
        'move_out.start',
        'repair.manage',
      ].sort(),
    );
  });
});

describe('沒有案件的物件：actionForUncasedObject', () => {
  it('合約動作依讀寫對應到沒有案件的合約動作', () => {
    expect(actionForUncasedObject('contract.read')).toBe('uncased_contract.read');
    for (const id of [
      'contract.draft_send',
      'contract.void',
      'contract.copy',
      'contract.resend',
      'contract.sign_link',
      'contract.refetch_files',
      'contract.simulate_signing',
    ] as const) {
      expect(actionForUncasedObject(id), id).toBe('uncased_contract.write');
    }
  });

  it('組織層動作原樣回傳', () => {
    for (const id of Object.keys(ORG_EXPECTATIONS)) {
      expect(actionForUncasedObject(id as ActionId), id).toBe(id);
    }
  });

  it('帳務、修繕、點交等案件動作沒有對應，不得因為沒有案件而放行', () => {
    for (const id of [
      'case.read_summary',
      'ledger.read',
      'ledger.record_payment',
      'ledger.record_deposit',
      'repair.manage',
      'inspection.confirm',
      'move_out.start',
      'deposit.dispute',
      'handover.initiate',
      'case_member.manage',
      'report.read_owner',
    ] as const) {
      expect(actionForUncasedObject(id), id).toBeNull();
    }
  });

  it('沒有案件的對應動作，寫入與讀取的組織角色與原動作不衝突', () => {
    // viewer 只讀：對應後的寫入動作必須是組織層的 write
    for (const id of ACTION_IDS) {
      const mapped = actionForUncasedObject(id);
      if (mapped === null) continue;
      const rule = ACTIONS[id];
      expect(ACTIONS[mapped].scope).toBe('org');
      expect(ACTIONS[mapped].effect).toBe(rule.effect);
    }
  });

  it('P0-09 權限表每一列至少有一個對應的動作', () => {
    // 預期值照 PRD P0-09 權限表的列名人工對照，不從 ACTIONS 推導
    const P0_09_ROWS: Record<string, ActionId[]> = {
      讀合約與帳務: ['contract.read', 'ledger.read', 'case.read_summary'],
      擬約與送簽: ['contract.draft_send'],
      登錄入帳確認與押金分錄: ['ledger.record_payment', 'ledger.record_deposit'],
      建立與處理修繕紀錄: ['repair.manage', 'repair.report'],
      確認點交: ['inspection.confirm'],
      對押金扣抵標示異議: ['deposit.dispute'],
      讀屋主報表: ['report.read_owner'],
      發起移交: ['handover.initiate'],
    };
    for (const [row, ids] of Object.entries(P0_09_ROWS)) {
      for (const id of ids) expect(ACTION_IDS, `${row} → ${id}`).toContain(id);
    }
    // 另含成員管理、稽核紀錄匯出（票的驗收條件）
    expect(ACTION_IDS).toContain('org_member.manage');
    expect(ACTION_IDS).toContain('audit.export');
  });
});
