// 屋主資產總覽的推導（MIL-94「總覽的租賃單位集合」「欄位與來源」「需要注意清單」「篩選與手機」）。
// 這裡只放純資料與純函式：事實由 OwnerOverviewSource 讀進來，畫面只呈現推導結果。
// 全部欄位是 v1 假設，待訪談驗證（MIL-47）。

// ─── 事實：OwnerOverviewSource 交給推導的輸入 ────────────────────────

/** 業務類型。包租列是屋主與包租業者之間的租約（MIL-94：包租列取自屋主自管案件）。 */
export type BusinessType = 'self_managed' | 'managed' | 'master_lease';

/** 租賃案件狀態（ADR-0016）。 */
export type LeaseCaseState = 'draft' | 'signing' | 'active' | 'move_out' | 'settling' | 'closed' | 'aborted';

/** 委託管理案件狀態（ADR-0016 決議 9）。 */
export type MandateCaseState = 'draft' | 'signing' | 'active' | 'terminated' | 'expired' | 'aborted';

/** 主要出租權源的狀態。 */
export type AuthorityStatus = 'verified' | 'pending' | 'failed' | 'expired';

/** 執業主體的驗證狀態。 */
export type PracticeEntityStatus = 'verified' | 'pending' | 'revoked';

/** 押金的收款帳戶持有人。 */
export type DepositHolder = 'owner' | 'manager' | 'other';

/** 簽署角色（GLOSSARY「簽名欄位」）。 */
export type SignerRole = '甲方' | '乙方' | '執業人員';

export type UnitFact = {
  unitId: string;
  address: string;
  unitLabel: string;
  /** 已合併時指向存續單位的 ID。 */
  mergedInto: string | null;
  authority: AuthorityStatus;
  /** 修繕紀錄的已報修加處理中。 */
  openRepairs: number;
};

export type PracticeEntityFact = {
  id: string;
  legalTitle: '租賃住宅代管業者' | '租賃住宅包租業者';
  name: string;
  status: PracticeEntityStatus;
};

/** 屋主為出租人的租賃案件。金額單位是新台幣元。 */
export type LeaseCaseFact = {
  caseId: string;
  orgId: string;
  unitId: string;
  businessType: BusinessType;
  state: LeaseCaseState;
  /** 代管業者或包租業者的執業主體；自管是 null。 */
  managerId: string | null;
  /** 屋主組織的案件對應的既有合約，用來連到合約詳情頁。 */
  contractId: string | null;
  /** 案件的租期迄日（ADR-0016 決議 15），YYYY-MM-DD。 */
  leaseEnd: string | null;
  /** 簽約中時目前輪到的簽署角色。 */
  awaitingSigner: SignerRole | null;
  receivableThisMonth: number;
  /** 配置到本月期別的金額。 */
  receivedThisMonth: number;
  /** 全部已逾期期別的累計未足額。 */
  overdue: number;
  depositExpected: number;
  depositBalance: number;
  depositHolder: DepositHolder | null;
  /** 最後一筆分錄的登錄日，YYYY-MM-DD。 */
  lastPostedAt: string | null;
  /** 代收的租金或押金超過約定日數未交付的天數；沒有逾期是 0。 */
  collectedFundsOverdueDays: number;
  /** 退租點交日，押金結算中用來算天數，YYYY-MM-DD。 */
  moveOutInspectedOn: string | null;
};

/** 屋主為委託人的委託管理案件。 */
export type MandateCaseFact = {
  caseId: string;
  orgId: string;
  managerId: string;
  state: MandateCaseState;
  /** 委託標的清單上的租賃單位 ID。 */
  unitIds: string[];
};

export type OverviewFacts = {
  ownerOrgId: string;
  units: UnitFact[];
  /** 屋主組織的物件涵蓋的租賃單位 ID。 */
  ownerOrgUnitIds: string[];
  leaseCases: LeaseCaseFact[];
  mandateCases: MandateCaseFact[];
  practiceEntities: PracticeEntityFact[];
  /** 讀取完成的時間，頁首的「資料截至」。 */
  asOf: string;
};

// ─── 推導結果 ──────────────────────────────────────────────────────

/** 列上的租約狀態：進行中的案件狀態，沒有時是空置。 */
export type LeaseState = 'vacant' | 'draft' | 'signing' | 'active' | 'move_out' | 'settling';

export type OverviewRow = {
  unitId: string;
  address: string;
  unitLabel: string;
  businessType: BusinessType;
  manager: PracticeEntityFact | null;
  leaseState: LeaseState;
  leaseEnd: string | null;
  awaitingSigner: SignerRole | null;
  receivable: number;
  received: number;
  overdue: number;
  depositExpected: number;
  depositBalance: number;
  depositHolder: DepositHolder | null;
  openRepairs: number;
  authority: AuthorityStatus;
  /** 帳務更新日；沒有分錄時是 null，畫面顯示「無」。 */
  ledgerUpdatedOn: string | null;
  /** 有出租中的案件在 60 天內到期（含已過期仍未退租）。 */
  expiringSoon: boolean;
  /** 點選後前往的頁面；其他組織的列暫時不可點，是 null。 */
  href: string | null;
  /** 這個單位進行中的案件，代表案件在第一個。需要注意清單要看全部案件。 */
  cases: LeaseCaseFact[];
};

export type RevokedManager = { manager: PracticeEntityFact; unitCount: number };

export type OverviewSummary = {
  unitCount: number;
  /** active 加 move_out。 */
  leased: number;
  vacant: number;
  receivable: number;
  received: number;
  overdue: number;
  depositBalance: number;
  openRepairs: number;
  asOf: string;
  /** 執業主體已失效的經理人與受影響的單位數；頁首顯示橫幅，不進需要注意清單。 */
  revokedManagers: RevokedManager[];
};

export type Overview = { summary: OverviewSummary; rows: OverviewRow[] };

// ─── 規則 ──────────────────────────────────────────────────────────

/** 「60 天內到期」的天數。60 是假設，待訪談驗證。 */
export const EXPIRING_WITHIN_DAYS = 60;

/** 代表案件的優先序，越前面越優先。closed、aborted 不在總覽內。 */
const REPRESENTATIVE_ORDER: readonly LeaseCaseState[] = ['active', 'move_out', 'settling', 'signing', 'draft'];

const LEASED_STATES: ReadonlySet<LeaseState> = new Set(['active', 'move_out']);

const BUSINESS_TYPE_ORDER: readonly BusinessType[] = ['self_managed', 'managed', 'master_lease'];

/** 兩個 YYYY-MM-DD 之間相差的天數（to - from）。 */
export function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

export function isLeaseExpiringSoon(c: LeaseCaseFact, today: string): boolean {
  return c.state === 'active' && c.leaseEnd !== null && daysBetween(today, c.leaseEnd) <= EXPIRING_WITHIN_DAYS;
}

function resolveUnitId(unitId: string, units: ReadonlyMap<string, UnitFact>): string {
  const seen = new Set<string>();
  let current = unitId;
  while (!seen.has(current)) {
    seen.add(current);
    const next = units.get(current)?.mergedInto;
    if (!next) return current;
    current = next;
  }
  return current;
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}

function latest(dates: readonly (string | null)[]): string | null {
  return dates.reduce<string | null>((max, d) => (d !== null && (max === null || d > max) ? d : max), null);
}

/**
 * 由事實推導頁首彙總與每列（MIL-94）。
 * 單位集合是三個來源的聯集：屋主組織的物件、屋主為出租人的租賃案件、有效委託管理案件的委託標的清單。
 */
export function deriveOverview(facts: OverviewFacts, today: string): Overview {
  const units = new Map(facts.units.map((u) => [u.unitId, u]));
  const managers = new Map(facts.practiceEntities.map((p) => [p.id, p]));
  const resolve = (id: string) => resolveUnitId(id, units);

  const openCases = facts.leaseCases.filter((c) => REPRESENTATIVE_ORDER.includes(c.state));
  const activeMandates = facts.mandateCases.filter((m) => m.state === 'active');

  const unitIds = new Set<string>();
  facts.ownerOrgUnitIds.forEach((id) => unitIds.add(resolve(id)));
  openCases.forEach((c) => unitIds.add(resolve(c.unitId)));
  activeMandates.forEach((m) => m.unitIds.forEach((id) => unitIds.add(resolve(id))));

  const rows: OverviewRow[] = [];
  for (const unitId of unitIds) {
    const unit = units.get(unitId);
    if (!unit) continue; // 事實不完整時不猜，接線票由 adapter 保證每個 ID 都有單位
    const cases = openCases
      .filter((c) => resolve(c.unitId) === unitId)
      .sort((a, b) => REPRESENTATIVE_ORDER.indexOf(a.state) - REPRESENTATIVE_ORDER.indexOf(b.state));
    const rep = cases[0] ?? null;
    const mandate = activeMandates.find((m) => m.unitIds.some((id) => resolve(id) === unitId)) ?? null;
    const managerId = rep ? rep.managerId : (mandate?.managerId ?? null);

    rows.push({
      unitId,
      address: unit.address,
      unitLabel: unit.unitLabel,
      businessType: rep?.businessType ?? (mandate ? 'managed' : 'self_managed'),
      manager: managerId ? (managers.get(managerId) ?? null) : null,
      leaseState: rep ? (rep.state as LeaseState) : 'vacant',
      leaseEnd: rep?.leaseEnd ?? null,
      awaitingSigner: rep?.state === 'signing' ? rep.awaitingSigner : null,
      receivable: sum(cases, (c) => c.receivableThisMonth),
      received: sum(cases, (c) => c.receivedThisMonth),
      overdue: sum(cases, (c) => c.overdue),
      // 約定與餘額同樣加總各案件，舊案件結算中、新案件出租中時兩者才對得起來
      depositExpected: sum(cases, (c) => c.depositExpected),
      depositBalance: sum(cases, (c) => c.depositBalance),
      depositHolder: rep?.depositHolder ?? null,
      openRepairs: unit.openRepairs,
      authority: unit.authority,
      ledgerUpdatedOn: latest(cases.map((c) => c.lastPostedAt)),
      expiringSoon: cases.some((c) => isLeaseExpiringSoon(c, today)),
      href: rep && rep.orgId === facts.ownerOrgId && rep.contractId !== null ? `/contracts/${rep.contractId}` : null,
      cases,
    });
  }

  rows.sort(
    (a, b) =>
      BUSINESS_TYPE_ORDER.indexOf(a.businessType) - BUSINESS_TYPE_ORDER.indexOf(b.businessType) ||
      a.unitId.localeCompare(b.unitId),
  );

  return { summary: summarize(rows, facts.asOf), rows };
}

function summarize(rows: readonly OverviewRow[], asOf: string): OverviewSummary {
  const leased = rows.filter((r) => LEASED_STATES.has(r.leaseState)).length;

  const revoked = new Map<string, RevokedManager>();
  for (const row of rows) {
    if (row.manager?.status !== 'revoked') continue;
    const hit = revoked.get(row.manager.id) ?? { manager: row.manager, unitCount: 0 };
    hit.unitCount += 1;
    revoked.set(row.manager.id, hit);
  }

  return {
    unitCount: rows.length,
    leased,
    vacant: rows.length - leased,
    receivable: sum(rows, (r) => r.receivable),
    received: sum(rows, (r) => r.received),
    overdue: sum(rows, (r) => r.overdue),
    depositBalance: sum(rows, (r) => r.depositBalance),
    openRepairs: sum(rows, (r) => r.openRepairs),
    asOf,
    revokedManagers: [...revoked.values()],
  };
}

// ─── 需要注意清單 ───────────────────────────────────────────────────

export type AttentionKind =
  | 'overdue'
  | 'authority_problem'
  | 'collected_funds_overdue'
  | 'deposit_settlement'
  | 'authority_pending'
  | 'lease_expiring';

/** 類別的排序（MIL-94「需要注意清單」）。排序是假設，待訪談驗證。 */
export const ATTENTION_ORDER: readonly AttentionKind[] = [
  'overdue',
  'authority_problem',
  'collected_funds_overdue',
  'deposit_settlement',
  'authority_pending',
  'lease_expiring',
];

export type AttentionItem = {
  key: string;
  kind: AttentionKind;
  unitId: string;
  address: string;
  unitLabel: string;
  href: string | null;
  /** 逾期金額；其他類別是 null。 */
  amount: number | null;
  /** 代收交付逾期天數、押金結算天數、租約剩餘天數；其他類別是 null。 */
  days: number | null;
  /** 出租權源的狀態，權源類別才有。 */
  authority: AuthorityStatus | null;
};

/** 同類別內的排序值，越小越前面。 */
function rankWithinKind(item: AttentionItem): number {
  switch (item.kind) {
    case 'overdue':
      return -(item.amount ?? 0);
    case 'collected_funds_overdue':
    case 'deposit_settlement':
      return -(item.days ?? 0);
    case 'lease_expiring':
      return item.days ?? 0;
    default:
      return 0;
  }
}

/**
 * 由每列推導需要注意清單（MIL-94）。清單不存表。
 * 同一單位命中多項時各自成列；非代表案件也要看。執業主體已失效改在頁首顯示，不進清單。
 */
export function deriveAttention(rows: readonly OverviewRow[], today: string): AttentionItem[] {
  const items: AttentionItem[] = [];

  for (const row of rows) {
    const push = (
      kind: AttentionKind,
      keySuffix: string,
      extra: Partial<Pick<AttentionItem, 'amount' | 'days' | 'authority'>> = {},
    ) =>
      items.push({
        key: `${row.unitId}:${kind}:${keySuffix}`,
        kind,
        unitId: row.unitId,
        address: row.address,
        unitLabel: row.unitLabel,
        href: row.href,
        amount: null,
        days: null,
        authority: null,
        ...extra,
      });

    if (row.authority === 'failed' || row.authority === 'expired') {
      push('authority_problem', 'unit', { authority: row.authority });
    } else if (row.authority === 'pending') {
      push('authority_pending', 'unit', { authority: row.authority });
    }

    for (const c of row.cases) {
      if (c.overdue > 0) push('overdue', c.caseId, { amount: c.overdue });
      if (c.collectedFundsOverdueDays > 0) {
        push('collected_funds_overdue', c.caseId, { days: c.collectedFundsOverdueDays });
      }
      if (c.state === 'settling') {
        const days = c.moveOutInspectedOn ? daysBetween(c.moveOutInspectedOn, today) : null;
        push('deposit_settlement', c.caseId, { days });
      }
      if (c.leaseEnd !== null && isLeaseExpiringSoon(c, today)) {
        push('lease_expiring', c.caseId, { days: daysBetween(today, c.leaseEnd) });
      }
    }
  }

  // Array.prototype.sort 是穩定排序：同類別同排序值時維持列的順序
  return items.sort(
    (a, b) =>
      ATTENTION_ORDER.indexOf(a.kind) - ATTENTION_ORDER.indexOf(b.kind) || rankWithinKind(a) - rankWithinKind(b),
  );
}

// ─── 篩選 ──────────────────────────────────────────────────────────

/** 全部租賃單位上方的篩選（P0-20 規則 3）。條件同時成立才列出；不影響需要注意清單。 */
export type OverviewFilter = {
  businessType: BusinessType | 'all';
  overdue: boolean;
  expiringSoon: boolean;
  authorityUnverified: boolean;
};

export const EMPTY_FILTER: OverviewFilter = {
  businessType: 'all',
  overdue: false,
  expiringSoon: false,
  authorityUnverified: false,
};

export function filterRows(rows: readonly OverviewRow[], filter: OverviewFilter): OverviewRow[] {
  return rows.filter(
    (r) =>
      (filter.businessType === 'all' || r.businessType === filter.businessType) &&
      (!filter.overdue || r.overdue > 0) &&
      (!filter.expiringSoon || r.expiringSoon) &&
      (!filter.authorityUnverified || r.authority !== 'verified'),
  );
}
