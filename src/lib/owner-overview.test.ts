import { describe, expect, it } from 'vitest';
import {
  deriveAttention,
  deriveOverview,
  EMPTY_FILTER,
  filterRows,
  type OverviewFilter,
  type OverviewRow,
  type LeaseCaseFact,
  type MandateCaseFact,
  type OverviewFacts,
  type PracticeEntityFact,
  type UnitFact,
} from './owner-overview';

const TODAY = '2026-11-08';
const OWNER_ORG = 'org-owner';

function unit(unitId: string, o: Partial<UnitFact> = {}): UnitFact {
  return {
    unitId,
    address: `台北市測試路 ${unitId} 號`,
    unitLabel: '整戶',
    mergedInto: null,
    authority: 'verified',
    openRepairs: 0,
    ...o,
  };
}

function lease(caseId: string, unitId: string, o: Partial<LeaseCaseFact> = {}): LeaseCaseFact {
  return {
    caseId,
    orgId: OWNER_ORG,
    unitId,
    businessType: 'self_managed',
    state: 'active',
    managerId: null,
    contractId: null,
    leaseEnd: '2027-12-31',
    awaitingSigner: null,
    receivableThisMonth: 0,
    receivedThisMonth: 0,
    overdue: 0,
    depositExpected: 0,
    depositBalance: 0,
    depositHolder: null,
    lastPostedAt: null,
    collectedFundsOverdueDays: 0,
    moveOutInspectedOn: null,
    ...o,
  };
}

function mandate(caseId: string, unitIds: string[], o: Partial<MandateCaseFact> = {}): MandateCaseFact {
  return { caseId, orgId: 'org-pm', managerId: 'pe-pm', state: 'active', unitIds, ...o };
}

const PM: PracticeEntityFact = {
  id: 'pe-pm',
  legalTitle: '租賃住宅代管業者',
  name: '甲山租賃管理股份有限公司',
  status: 'verified',
};

function facts(o: Partial<OverviewFacts> = {}): OverviewFacts {
  return {
    ownerOrgId: OWNER_ORG,
    units: [],
    ownerOrgUnitIds: [],
    leaseCases: [],
    mandateCases: [],
    practiceEntities: [PM],
    asOf: '2026-11-08T09:00:00+08:00',
    ...o,
  };
}

const ids = (f: OverviewFacts) => deriveOverview(f, TODAY).rows.map((r) => r.unitId);

describe('deriveOverview：租賃單位集合', () => {
  it.each([
    {
      name: '屋主組織的物件，沒有案件也列出',
      f: facts({ units: [unit('u1')], ownerOrgUnitIds: ['u1'] }),
      expected: ['u1'],
    },
    {
      name: '屋主為出租人的租賃案件',
      f: facts({ units: [unit('u1')], leaseCases: [lease('c1', 'u1', { orgId: 'org-pm' })] }),
      expected: ['u1'],
    },
    {
      name: '已結案與已放棄的租賃案件不帶入單位',
      f: facts({
        units: [unit('u1'), unit('u2')],
        leaseCases: [lease('c1', 'u1', { state: 'closed' }), lease('c2', 'u2', { state: 'aborted' })],
      }),
      expected: [],
    },
    {
      name: '有效委託管理案件的委託標的清單，沒有租賃案件也列出',
      f: facts({ units: [unit('u1'), unit('u2')], mandateCases: [mandate('m1', ['u1', 'u2'])] }),
      expected: ['u1', 'u2'],
    },
    {
      name: '不是 active 的委託管理案件不帶入單位',
      f: facts({
        units: [unit('u1'), unit('u2')],
        mandateCases: [mandate('m1', ['u1'], { state: 'terminated' }), mandate('m2', ['u2'], { state: 'draft' })],
      }),
      expected: [],
    },
    {
      name: '三個來源指到同一單位時只列一次',
      f: facts({
        units: [unit('u1')],
        ownerOrgUnitIds: ['u1'],
        leaseCases: [lease('c1', 'u1')],
        mandateCases: [mandate('m1', ['u1'])],
      }),
      expected: ['u1'],
    },
    {
      name: '已合併的 ID 解析到存續單位',
      f: facts({
        units: [unit('u-old', { mergedInto: 'u-new' }), unit('u-new')],
        ownerOrgUnitIds: ['u-old'],
        mandateCases: [mandate('m1', ['u-new'])],
      }),
      expected: ['u-new'],
    },
  ])('$name', ({ f, expected }) => {
    expect(ids(f)).toEqual(expected);
  });

  it('沒有任何租賃單位時列與彙總都是空的', () => {
    const { rows, summary } = deriveOverview(facts(), TODAY);
    expect(rows).toEqual([]);
    expect(summary.unitCount).toBe(0);
  });
});

describe('deriveOverview：代表案件與租約狀態', () => {
  it.each([
    { states: ['draft', 'active'], expected: 'active' },
    { states: ['settling', 'signing'], expected: 'settling' },
    { states: ['signing', 'move_out', 'settling'], expected: 'move_out' },
    { states: ['draft', 'signing'], expected: 'signing' },
    { states: ['draft'], expected: 'draft' },
  ] as const)('案件 $states 時代表案件是 $expected', ({ states, expected }) => {
    const f = facts({
      units: [unit('u1')],
      leaseCases: states.map((state, i) => lease(`c${i}`, 'u1', { state })),
    });
    expect(deriveOverview(f, TODAY).rows[0].leaseState).toBe(expected);
  });

  it('沒有進行中的案件時是空置', () => {
    const f = facts({ units: [unit('u1')], ownerOrgUnitIds: ['u1'] });
    expect(deriveOverview(f, TODAY).rows[0].leaseState).toBe('vacant');
  });

  it('簽約中的列帶出等待簽署的角色', () => {
    const f = facts({
      units: [unit('u1')],
      leaseCases: [lease('c1', 'u1', { state: 'signing', awaitingSigner: '乙方' })],
    });
    expect(deriveOverview(f, TODAY).rows[0].awaitingSigner).toBe('乙方');
  });

  it('只出現在委託標的清單的空置單位，業務類型是代管、經理人是受託人', () => {
    const f = facts({ units: [unit('u1')], mandateCases: [mandate('m1', ['u1'])] });
    const row = deriveOverview(f, TODAY).rows[0];
    expect(row.businessType).toBe('managed');
    expect(row.manager?.name).toBe('甲山租賃管理股份有限公司');
  });

  it('只出現在屋主組織的空置單位是自管、沒有經理人', () => {
    const f = facts({ units: [unit('u1')], ownerOrgUnitIds: ['u1'] });
    const row = deriveOverview(f, TODAY).rows[0];
    expect(row.businessType).toBe('self_managed');
    expect(row.manager).toBeNull();
  });
});

describe('deriveOverview：頁首彙總', () => {
  const f = facts({
    units: [unit('u1', { openRepairs: 2 }), unit('u2'), unit('u3', { openRepairs: 1 }), unit('u4'), unit('u5')],
    ownerOrgUnitIds: ['u5'],
    leaseCases: [
      lease('c1', 'u1', {
        state: 'active',
        receivableThisMonth: 20000,
        receivedThisMonth: 20000,
        depositBalance: 40000,
      }),
      lease('c2', 'u2', {
        state: 'move_out',
        receivableThisMonth: 15000,
        receivedThisMonth: 5000,
        overdue: 25000,
        depositBalance: 30000,
      }),
      lease('c3', 'u3', { state: 'settling', depositBalance: 12000 }),
      lease('c4', 'u4', { state: 'signing' }),
    ],
  });
  const { summary } = deriveOverview(f, TODAY);

  it.each([
    ['unitCount', 5],
    ['leased', 2],
    ['vacant', 3],
    ['receivable', 35000],
    ['received', 25000],
    ['overdue', 25000],
    ['depositBalance', 82000],
    ['openRepairs', 3],
  ] as const)('%s = %d', (key, value) => {
    expect(summary[key]).toBe(value);
  });

  it('資料截至取自讀取完成的時間', () => {
    expect(summary.asOf).toBe('2026-11-08T09:00:00+08:00');
  });

  it('同一單位有多個案件時金額加總各案件', () => {
    const g = facts({
      units: [unit('u1')],
      leaseCases: [
        lease('old', 'u1', { state: 'settling', overdue: 8000, depositBalance: 10000 }),
        lease('new', 'u1', { state: 'active', receivableThisMonth: 12000, depositBalance: 24000 }),
      ],
    });
    const { rows, summary: s } = deriveOverview(g, TODAY);
    expect(rows[0].overdue).toBe(8000);
    expect(rows[0].depositBalance).toBe(34000);
    expect(s.overdue).toBe(8000);
  });

  it('執業主體已失效時列出受影響的單位數，其他狀態不列', () => {
    const revoked: PracticeEntityFact = { ...PM, id: 'pe-gone', name: '乙禾物業', status: 'revoked' };
    const g = facts({
      practiceEntities: [PM, revoked],
      units: [unit('u1'), unit('u2'), unit('u3')],
      leaseCases: [
        lease('c1', 'u1', { orgId: 'org-gone', businessType: 'managed', managerId: 'pe-gone' }),
        lease('c2', 'u2', { orgId: 'org-pm', businessType: 'managed', managerId: 'pe-pm' }),
      ],
      mandateCases: [mandate('m1', ['u3'], { managerId: 'pe-gone', orgId: 'org-gone' })],
    });
    expect(deriveOverview(g, TODAY).summary.revokedManagers).toEqual([{ manager: revoked, unitCount: 2 }]);
  });
});

describe('deriveOverview：每列', () => {
  it('帳務更新日取最後一筆分錄日，沒有分錄時是 null', () => {
    const f = facts({
      units: [unit('u1'), unit('u2')],
      leaseCases: [
        lease('a', 'u1', { state: 'settling', lastPostedAt: '2026-10-30' }),
        lease('b', 'u1', { state: 'active', lastPostedAt: '2026-11-05' }),
        lease('c', 'u2'),
      ],
    });
    const rows = deriveOverview(f, TODAY).rows;
    expect(rows.find((r) => r.unitId === 'u1')?.ledgerUpdatedOn).toBe('2026-11-05');
    expect(rows.find((r) => r.unitId === 'u2')?.ledgerUpdatedOn).toBeNull();
  });

  it.each([
    { name: '屋主組織且有合約時連到合約詳情頁', o: { orgId: OWNER_ORG, contractId: 7 }, href: '/contracts/7' },
    { name: '其他組織的案件不可點', o: { orgId: 'org-pm', contractId: 7 }, href: null },
    { name: '屋主組織但沒有合約時不可點', o: { orgId: OWNER_ORG, contractId: null }, href: null },
  ])('$name', ({ o, href }) => {
    const f = facts({ units: [unit('u1')], leaseCases: [lease('c1', 'u1', o)] });
    expect(deriveOverview(f, TODAY).rows[0].href).toBe(href);
  });

  it('押金持有人取自代表案件', () => {
    const f = facts({
      units: [unit('u1')],
      leaseCases: [lease('c1', 'u1', { depositHolder: 'manager', depositExpected: 50000 })],
    });
    const row = deriveOverview(f, TODAY).rows[0];
    expect(row.depositHolder).toBe('manager');
    expect(row.depositExpected).toBe(50000);
  });
});

// ─── 需要注意清單 ───────────────────────────────────────────────────

/** 一個單位一個案件的列，案件與單位的欄位各自覆寫。 */
function row(unitId: string, u: Partial<UnitFact> = {}, c: Partial<LeaseCaseFact> | null = {}): OverviewRow {
  const f = facts({
    units: [unit(unitId, u)],
    ownerOrgUnitIds: [unitId],
    leaseCases: c === null ? [] : [lease(`case-${unitId}`, unitId, c)],
  });
  return deriveOverview(f, TODAY).rows[0];
}

const kinds = (rows: OverviewRow[]) => deriveAttention(rows, TODAY).map((a) => `${a.kind}:${a.unitId}`);

describe('deriveAttention：項目', () => {
  it.each([
    { name: '有逾期期別', r: row('u1', {}, { overdue: 6500 }), expected: ['overdue:u1'] },
    { name: '出租權源驗證失敗', r: row('u1', { authority: 'failed' }), expected: ['authority_problem:u1'] },
    { name: '出租權源已失效', r: row('u1', { authority: 'expired' }), expected: ['authority_problem:u1'] },
    {
      name: '代收交付逾期',
      r: row('u1', {}, { collectedFundsOverdueDays: 3 }),
      expected: ['collected_funds_overdue:u1'],
    },
    {
      name: '押金結算中',
      r: row('u1', {}, { state: 'settling', moveOutInspectedOn: '2026-11-01' }),
      expected: ['deposit_settlement:u1'],
    },
    { name: '出租權源待驗證', r: row('u1', { authority: 'pending' }), expected: ['authority_pending:u1'] },
    { name: '出租中且 60 天內到期', r: row('u1', {}, { leaseEnd: '2027-01-07' }), expected: ['lease_expiring:u1'] },
    { name: '第 61 天到期不列', r: row('u1', {}, { leaseEnd: '2027-01-08' }), expected: [] },
    { name: '已過到期日仍出租中也列', r: row('u1', {}, { leaseEnd: '2026-11-01' }), expected: ['lease_expiring:u1'] },
    { name: '不是出租中時到期不列', r: row('u1', {}, { state: 'move_out', leaseEnd: '2026-12-01' }), expected: [] },
    {
      name: '押金在代管業者手上本身不列',
      r: row('u1', {}, { depositHolder: 'manager', depositBalance: 56000 }),
      expected: [],
    },
    { name: '沒有案件的空置單位沒有項目', r: row('u1', {}, null), expected: [] },
  ])('$name', ({ r, expected }) => {
    expect(kinds([r])).toEqual(expected);
  });

  it('執業主體已失效不進清單', () => {
    const revoked: PracticeEntityFact = { ...PM, status: 'revoked' };
    const f = facts({
      practiceEntities: [revoked],
      units: [unit('u1')],
      leaseCases: [lease('c1', 'u1', { businessType: 'managed', managerId: PM.id })],
    });
    expect(deriveAttention(deriveOverview(f, TODAY).rows, TODAY)).toEqual([]);
  });

  it('同一單位命中多項時各自成列', () => {
    const r = row('u1', { authority: 'pending' }, { overdue: 1000, leaseEnd: '2026-12-01' });
    expect(kinds([r])).toEqual(['overdue:u1', 'authority_pending:u1', 'lease_expiring:u1']);
  });

  it('非代表案件也進清單：同單位舊案件結算中、新案件出租中', () => {
    const f = facts({
      units: [unit('u1')],
      leaseCases: [
        lease('old', 'u1', { state: 'settling', overdue: 3000, moveOutInspectedOn: '2026-11-01' }),
        lease('new', 'u1', { state: 'active' }),
      ],
    });
    expect(kinds(deriveOverview(f, TODAY).rows)).toEqual(['overdue:u1', 'deposit_settlement:u1']);
  });

  it('帶出金額與天數', () => {
    const items = deriveAttention(
      [
        row('u1', {}, { overdue: 6500 }),
        row('u2', {}, { collectedFundsOverdueDays: 4 }),
        row('u3', {}, { state: 'settling', moveOutInspectedOn: '2026-11-01' }),
        row('u4', {}, { leaseEnd: '2026-12-08' }),
      ],
      TODAY,
    );
    expect(items.map((a) => [a.kind, a.amount, a.days])).toEqual([
      ['overdue', 6500, null],
      ['collected_funds_overdue', null, 4],
      ['deposit_settlement', null, 7],
      ['lease_expiring', null, 30],
    ]);
  });
});

describe('deriveAttention：排序', () => {
  it('依類別排序：逾期、權源有問題、代收交付逾期、押金結算、權源待驗證、租約到期', () => {
    const rows = [
      row('a', {}, { leaseEnd: '2026-12-01' }),
      row('b', { authority: 'pending' }),
      row('c', {}, { state: 'settling', moveOutInspectedOn: '2026-11-01' }),
      row('d', {}, { collectedFundsOverdueDays: 2 }),
      row('e', { authority: 'failed' }),
      row('f', {}, { overdue: 100 }),
    ];
    expect(kinds(rows)).toEqual([
      'overdue:f',
      'authority_problem:e',
      'collected_funds_overdue:d',
      'deposit_settlement:c',
      'authority_pending:b',
      'lease_expiring:a',
    ]);
  });

  it.each([
    {
      name: '逾期金額大到小',
      rows: [row('a', {}, { overdue: 1000 }), row('b', {}, { overdue: 36000 }), row('c', {}, { overdue: 6500 })],
      expected: ['overdue:b', 'overdue:c', 'overdue:a'],
    },
    {
      name: '代收交付逾期天數多到少',
      rows: [row('a', {}, { collectedFundsOverdueDays: 2 }), row('b', {}, { collectedFundsOverdueDays: 9 })],
      expected: ['collected_funds_overdue:b', 'collected_funds_overdue:a'],
    },
    {
      name: '押金結算天數多到少',
      rows: [
        row('a', {}, { state: 'settling', moveOutInspectedOn: '2026-11-05' }),
        row('b', {}, { state: 'settling', moveOutInspectedOn: '2026-10-20' }),
      ],
      expected: ['deposit_settlement:b', 'deposit_settlement:a'],
    },
    {
      name: '租約剩餘天數少到多',
      rows: [row('a', {}, { leaseEnd: '2026-12-31' }), row('b', {}, { leaseEnd: '2026-11-20' })],
      expected: ['lease_expiring:b', 'lease_expiring:a'],
    },
  ])('同類別內：$name', ({ rows, expected }) => {
    expect(kinds(rows)).toEqual(expected);
  });
});

// ─── 篩選 ──────────────────────────────────────────────────────────

describe('filterRows', () => {
  const rows = [
    row('self-ok', {}, { leaseEnd: '2027-12-31' }),
    row('self-overdue', {}, { overdue: 5000 }),
    row('managed-expiring', {}, { businessType: 'managed', leaseEnd: '2026-12-01' }),
    row('master-pending', { authority: 'pending' }, { businessType: 'master_lease' }),
    row('managed-failed-overdue', { authority: 'failed' }, { businessType: 'managed', overdue: 100 }),
  ];
  const pick = (filter: Partial<OverviewFilter>) =>
    filterRows(rows, { ...EMPTY_FILTER, ...filter }).map((r) => r.unitId);

  it.each([
    { name: '沒有條件時全部列出', filter: {}, expected: rows.map((r) => r.unitId) },
    { name: '業務類型：自管', filter: { businessType: 'self_managed' }, expected: ['self-ok', 'self-overdue'] },
    {
      name: '業務類型：代管',
      filter: { businessType: 'managed' },
      expected: ['managed-expiring', 'managed-failed-overdue'],
    },
    { name: '業務類型：包租', filter: { businessType: 'master_lease' }, expected: ['master-pending'] },
    { name: '逾期', filter: { overdue: true }, expected: ['self-overdue', 'managed-failed-overdue'] },
    { name: '60 天內到期', filter: { expiringSoon: true }, expected: ['managed-expiring'] },
    {
      name: '權源未驗證：待驗證、驗證失敗、已失效都算',
      filter: { authorityUnverified: true },
      expected: ['master-pending', 'managed-failed-overdue'],
    },
    {
      name: '條件同時成立才列出',
      filter: { businessType: 'managed', overdue: true, authorityUnverified: true },
      expected: ['managed-failed-overdue'],
    },
    { name: '沒有符合的列', filter: { businessType: 'master_lease', overdue: true }, expected: [] },
  ] satisfies { name: string; filter: Partial<OverviewFilter>; expected: string[] }[])(
    '$name',
    ({ filter, expected }) => {
      expect(pick(filter)).toEqual(expected);
    },
  );
});
