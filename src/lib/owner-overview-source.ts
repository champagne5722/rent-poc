// 總覽讀資料的 seam（MIL-94「總覽的資料來源」）。
// 這張票（MIL-96）只有假資料 adapter；PostgreSQL adapter 由接線票 MIL-99、MIL-101、MIL-102 提供。
// 推導規則不放這裡，全部在 owner-overview.ts。

import type { OverviewFacts } from './owner-overview';
import { SEED_OWNERS, type OwnerSession } from './owner-session';

export interface OwnerOverviewSource {
  /** 讀取屋主跨組織的全部事實。asOf 是讀取完成的時間。 */
  load(session: OwnerSession): Promise<OverviewFacts>;
}

/** 台灣時區的今天，YYYY-MM-DD。 */
export function todayInTaipei(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * 假資料 adapter。日期以今天為基準往前後推，讓「60 天內到期」「押金結算天數」不隨日期失效。
 * 第一位 seed 屋主涵蓋自管、兩家代管、包租、空置、簽約中、押金結算中、執業主體已失效；
 * 第二位 seed 屋主沒有任何租賃單位，用來看空狀態。公司、地址與 ID 都是虛構的。
 */
export function createFakeOverviewSource(now: () => Date = () => new Date()): OwnerOverviewSource {
  return {
    async load(session) {
      const at = now();
      const today = todayInTaipei(at);
      const facts =
        session.partyId === SEED_OWNERS[0]?.partyId ? demoPortfolio(session.ownerOrgId, today) : emptyPortfolio(session);
      return { ...facts, asOf: at.toISOString() };
    },
  };
}

function emptyPortfolio(session: OwnerSession): Omit<OverviewFacts, 'asOf'> {
  return {
    ownerOrgId: session.ownerOrgId,
    units: [],
    ownerOrgUnitIds: [],
    leaseCases: [],
    mandateCases: [],
    practiceEntities: [],
  };
}

const JIASHAN = 'pe-jiashan';
const YIHE = 'pe-yihe';
const BINGCHEN = 'pe-bingchen';

function demoPortfolio(ownerOrgId: string, today: string): Omit<OverviewFacts, 'asOf'> {
  const d = (days: number) => addDays(today, days);
  const base = {
    contractId: null,
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
  } as const;

  return {
    ownerOrgId,
    practiceEntities: [
      { id: JIASHAN, legalTitle: '租賃住宅代管業者', name: '甲山租賃管理股份有限公司', status: 'verified' },
      { id: YIHE, legalTitle: '租賃住宅代管業者', name: '乙禾物業管理股份有限公司', status: 'revoked' },
      { id: BINGCHEN, legalTitle: '租賃住宅包租業者', name: '丙辰包租股份有限公司', status: 'verified' },
    ],
    units: [
      { unitId: '6300-1234-0000', address: '台北市大安區和平東路二段 118 號 5 樓', unitLabel: '整戶', mergedInto: null, authority: 'verified', openRepairs: 0 },
      { unitId: '6500-0871-0000', address: '新北市板橋區文化路一段 66 號 3 樓', unitLabel: '整戶', mergedInto: null, authority: 'verified', openRepairs: 1 },
      { unitId: '6300-4410-0000', address: '台北市大安區復興南路一段 240 號 6 樓', unitLabel: '整戶', mergedInto: null, authority: 'pending', openRepairs: 0 },
      { unitId: '6300-2205-0000', address: '台北市中山區松江路 200 號 8 樓之 3', unitLabel: '整戶', mergedInto: null, authority: 'verified', openRepairs: 0 },
      { unitId: '6300-3380-0000', address: '台北市信義區基隆路一段 300 號 12 樓', unitLabel: '整戶', mergedInto: null, authority: 'verified', openRepairs: 2 },
      { unitId: '6300-5512-0002', address: '台北市文山區木柵路三段 88 號 4 樓', unitLabel: '房間 A', mergedInto: null, authority: 'verified', openRepairs: 1 },
      { unitId: '6300-5512-0003', address: '台北市文山區木柵路三段 88 號 4 樓', unitLabel: '房間 B', mergedInto: null, authority: 'failed', openRepairs: 0 },
      { unitId: '6500-1990-0000', address: '新北市永和區中正路 500 號 7 樓', unitLabel: '整戶', mergedInto: null, authority: 'verified', openRepairs: 0 },
      { unitId: '6600-0456-0000', address: '台中市西區公益路 150 號 9 樓', unitLabel: '整戶', mergedInto: null, authority: 'pending', openRepairs: 0 },
    ],
    // 屋主組織的物件：板橋那間空置，沒有任何案件
    ownerOrgUnitIds: ['6300-1234-0000', '6500-0871-0000', '6300-4410-0000', '6600-0456-0000'],
    mandateCases: [
      // 甲山的委託標的清單包含沒有租賃案件的房間 B（空置）
      { caseId: 'mc-jiashan', orgId: 'org-jiashan', managerId: JIASHAN, state: 'active', unitIds: ['6300-2205-0000', '6300-3380-0000', '6300-5512-0002', '6300-5512-0003'] },
      { caseId: 'mc-yihe', orgId: 'org-yihe', managerId: YIHE, state: 'active', unitIds: ['6500-1990-0000'] },
    ],
    leaseCases: [
      // 自管，出租中，54 天後到期
      {
        ...base,
        caseId: 'lc-heping',
        orgId: ownerOrgId,
        unitId: '6300-1234-0000',
        businessType: 'self_managed',
        state: 'active',
        managerId: null,
        contractId: 1,
        leaseEnd: d(54),
        receivableThisMonth: 32000,
        receivedThisMonth: 32000,
        depositExpected: 64000,
        depositBalance: 64000,
        depositHolder: 'owner',
        lastPostedAt: d(-5),
      },
      // 自管，簽約中，等待乙方簽署
      {
        ...base,
        caseId: 'lc-fuxing',
        orgId: ownerOrgId,
        unitId: '6300-4410-0000',
        businessType: 'self_managed',
        state: 'signing',
        managerId: null,
        contractId: 2,
        leaseEnd: d(380),
        awaitingSigner: '乙方',
        depositExpected: 60000,
      },
      // 甲山代管，押金結算中，退租點交後第 7 天
      {
        ...base,
        caseId: 'lc-songjiang',
        orgId: 'org-jiashan',
        unitId: '6300-2205-0000',
        businessType: 'managed',
        state: 'settling',
        managerId: JIASHAN,
        leaseEnd: d(-8),
        depositExpected: 50000,
        depositBalance: 12000,
        depositHolder: 'owner',
        lastPostedAt: d(-3),
        moveOutInspectedOn: d(-7),
      },
      // 甲山代管，出租中，押金在代管業者帳戶，代收租金逾約定日數 4 天未交付
      {
        ...base,
        caseId: 'lc-keelung',
        orgId: 'org-jiashan',
        unitId: '6300-3380-0000',
        businessType: 'managed',
        state: 'active',
        managerId: JIASHAN,
        leaseEnd: d(335),
        receivableThisMonth: 28000,
        receivedThisMonth: 28000,
        depositExpected: 56000,
        depositBalance: 56000,
        depositHolder: 'manager',
        lastPostedAt: d(-3),
        collectedFundsOverdueDays: 4,
      },
      // 甲山代管，出租中，本月部分入帳
      {
        ...base,
        caseId: 'lc-muzha-a',
        orgId: 'org-jiashan',
        unitId: '6300-5512-0002',
        businessType: 'managed',
        state: 'active',
        managerId: JIASHAN,
        leaseEnd: d(279),
        receivableThisMonth: 12500,
        receivedThisMonth: 6000,
        overdue: 6500,
        depositExpected: 25000,
        depositBalance: 25000,
        depositHolder: 'owner',
        lastPostedAt: d(-3),
      },
      // 乙禾代管（執業主體已失效），出租中，累計逾期兩期
      {
        ...base,
        caseId: 'lc-yonghe',
        orgId: 'org-yihe',
        unitId: '6500-1990-0000',
        businessType: 'managed',
        state: 'active',
        managerId: YIHE,
        leaseEnd: d(143),
        receivableThisMonth: 18000,
        receivedThisMonth: 0,
        overdue: 36000,
        depositExpected: 36000,
        depositBalance: 36000,
        depositHolder: 'manager',
        lastPostedAt: d(-41),
      },
      // 包租：屋主與丙辰的租約，屬屋主組織的自管案件
      {
        ...base,
        caseId: 'lc-gongyi',
        orgId: ownerOrgId,
        unitId: '6600-0456-0000',
        businessType: 'master_lease',
        state: 'active',
        managerId: BINGCHEN,
        contractId: 3,
        leaseEnd: d(815),
        receivableThisMonth: 20000,
        receivedThisMonth: 20000,
        depositExpected: 40000,
        depositBalance: 40000,
        depositHolder: 'owner',
        lastPostedAt: d(-6),
      },
    ],
  };
}
