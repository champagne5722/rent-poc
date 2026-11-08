// 移交畫面的假資料。公司名、人名、地址、帳號都是虛構的。
// 屋主是 owner-session.ts 的第一位 seed 屋主。涵蓋：兩個代管租賃案件、一個簽署中被擋下的案件、
// 一個委託標的清單上的空置單位、一個交出側已完成的移交、一個已完成的移交。
import type { HandoverSeed } from './memory-store';
import { buildHandoverSnapshot, type HandoverManualFields } from './snapshot';
import { hashHandoverSnapshot } from './snapshot-hash';
import type { HandoverRecord, PracticeEntityRef, UnitHandoverSource } from './store';

export const DEMO_OWNER_PARTY_ID = 'party-owner-demo-1';

const MANAGER_TITLE = '租賃住宅代管業者';

const QINGHE: PracticeEntityRef = {
  orgId: 'org-pe-qinghe',
  name: '青禾租賃住宅管理有限公司',
  statutoryTitle: MANAGER_TITLE,
  status: 'lapsed',
};
const BEICHEN: PracticeEntityRef = {
  orgId: 'org-pe-beichen',
  name: '北辰租賃住宅管理股份有限公司',
  statutoryTitle: MANAGER_TITLE,
  status: 'verified',
};
const SUILIN: PracticeEntityRef = {
  orgId: 'org-pe-suilin',
  name: '穗林物業管理顧問有限公司',
  statutoryTitle: MANAGER_TITLE,
  status: 'verified',
};
const QINGCHUAN: PracticeEntityRef = {
  orgId: 'org-pe-qingchuan',
  name: '晴川租賃管理有限公司',
  statutoryTitle: MANAGER_TITLE,
  status: 'lapsed',
};
const YUANFAN: PracticeEntityRef = {
  orgId: 'org-pe-yuanfan',
  name: '遠帆租賃住宅管理有限公司',
  statutoryTitle: MANAGER_TITLE,
  status: 'pending',
};
const YAOSHI: PracticeEntityRef = {
  orgId: 'org-pe-yaoshi',
  name: '曜石不動產管理有限公司',
  statutoryTitle: MANAGER_TITLE,
  status: 'verified',
};

const sha = (seed: string) => seed.repeat(64).slice(0, 64);

const UNIT_SOURCES: UnitHandoverSource[] = [
  {
    rentalUnitId: 'ru-0101',
    hasActiveSigningTask: false,
    currentAccountHolder: QINGHE.name,
    snapshot: {
      hasLeaseCase: true,
      title: { leaseAuthorityStatus: 'verified', transcriptFetchedAt: '2026-08-14' },
      people: {
        managementContract: { id: 'mc-0101', signedPdfSha256: sha('3f') },
        leaseContract: { id: 'lc-0101', signedPdfSha256: sha('a7') },
      },
      condition: {
        moveInRecord: { id: 'mi-0101', name: '入住點交紀錄 2025-03-01' },
        conditionAttachments: [{ id: 'att-0101', name: '現況照片 18 張' }],
        equipmentAttachments: [],
      },
      money: {
        depositBalance: 46000,
        prepaidRentBalance: 23000,
        unpaidPeriods: [{ periodId: 'rp-0101-2610', month: '2026-10', remaining: 8000 }],
        uncollectedRemittance: 23000,
      },
      repairs: [{ id: 'rr-0101', title: '浴室排水緩慢', status: 'in_progress' }],
    },
  },
  {
    rentalUnitId: 'ru-0102',
    hasActiveSigningTask: true,
    currentAccountHolder: QINGHE.name,
    snapshot: {
      hasLeaseCase: true,
      title: { leaseAuthorityStatus: 'verified', transcriptFetchedAt: '2026-08-14' },
      people: {
        managementContract: { id: 'mc-0101', signedPdfSha256: sha('3f') },
        leaseContract: null,
      },
      condition: { moveInRecord: null, conditionAttachments: [], equipmentAttachments: [] },
      money: { depositBalance: 0, prepaidRentBalance: 0, unpaidPeriods: [], uncollectedRemittance: 0 },
      repairs: [],
    },
  },
  {
    rentalUnitId: 'ru-0103',
    hasActiveSigningTask: false,
    currentAccountHolder: null,
    snapshot: {
      hasLeaseCase: false,
      title: { leaseAuthorityStatus: 'pending', transcriptFetchedAt: null },
      people: { managementContract: { id: 'mc-0101', signedPdfSha256: sha('3f') }, leaseContract: null },
      condition: { moveInRecord: null, conditionAttachments: [], equipmentAttachments: [] },
      money: { depositBalance: null, prepaidRentBalance: null, unpaidPeriods: null, uncollectedRemittance: null },
      repairs: [],
    },
  },
  {
    rentalUnitId: 'ru-0201',
    hasActiveSigningTask: false,
    currentAccountHolder: BEICHEN.name,
    snapshot: {
      hasLeaseCase: true,
      title: { leaseAuthorityStatus: 'verified', transcriptFetchedAt: '2026-06-02' },
      people: {
        managementContract: { id: 'mc-0201', signedPdfSha256: sha('5c') },
        leaseContract: { id: 'lc-0201', signedPdfSha256: sha('e1') },
      },
      condition: {
        moveInRecord: { id: 'mi-0201', name: '入住點交紀錄 2026-01-15' },
        conditionAttachments: [{ id: 'att-0201', name: '現況照片 12 張' }],
        equipmentAttachments: [{ id: 'att-0202', name: '設備清單' }],
      },
      money: { depositBalance: 52000, prepaidRentBalance: 0, unpaidPeriods: [], uncollectedRemittance: 0 },
      repairs: [],
    },
  },
];

const FILLED: HandoverManualFields = {
  keyHandover: '大門鑰匙 2 把、信箱鑰匙 1 把，已交付',
  accessCardHandover: '門禁感應扣 2 個，已交付',
  committeeContact: '管委會總幹事，週一至週五 9 時至 18 時',
};

function frozen(id: string, rentalUnitId: string, source: UnitHandoverSource['snapshot'], manual: HandoverManualFields) {
  const snapshot = buildHandoverSnapshot({ handoverId: id, rentalUnitId, manual, ...source });
  return { frozenSnapshot: snapshot, snapshotHash: hashHandoverSnapshot(snapshot) };
}

const RELEASED_SOURCE: UnitHandoverSource['snapshot'] = {
  hasLeaseCase: true,
  title: { leaseAuthorityStatus: 'verified', transcriptFetchedAt: '2026-09-20' },
  people: {
    managementContract: { id: 'mc-0202', signedPdfSha256: sha('8b') },
    leaseContract: { id: 'lc-0202', signedPdfSha256: sha('d4') },
  },
  condition: {
    moveInRecord: { id: 'mi-0202', name: '入住點交紀錄 2025-11-01' },
    conditionAttachments: [{ id: 'att-0203', name: '現況照片 9 張' }],
    equipmentAttachments: [{ id: 'att-0204', name: '設備清單' }],
  },
  money: { depositBalance: 40000, prepaidRentBalance: 0, unpaidPeriods: [], uncollectedRemittance: 0 },
  repairs: [],
};

const HANDOVERS: HandoverRecord[] = [
  {
    id: 'ho-0001',
    ownerPartyId: DEMO_OWNER_PARTY_ID,
    mandateCaseId: 'mc-0301',
    rentalUnitId: 'ru-0301',
    address: '臺北市松山區八德路四段 120 號 6 樓',
    unitLabel: '6 樓',
    leaseCaseId: 'lc-0301',
    from: { orgId: QINGCHUAN.orgId, name: QINGCHUAN.name },
    target: { kind: 'mandatary', orgId: BEICHEN.orgId, name: BEICHEN.name },
    state: 'completed',
    effectiveDate: '2026-09-01',
    acknowledgedMissing: [],
    manual: FILLED,
    ...frozen('ho-0001', 'ru-0301', RELEASED_SOURCE, FILLED),
    createdAt: '2026-08-18T02:00:00.000Z',
    events: [
      { type: 'handover_draft_created', at: '2026-08-18T02:00:00.000Z' },
      { type: 'handover_owner_confirm', at: '2026-08-18T03:10:00.000Z' },
      { type: 'handover_accept', at: '2026-08-20T06:30:00.000Z' },
      { type: 'handover_release', at: '2026-08-31T16:00:05.000Z' },
      { type: 'handover_receive', at: '2026-08-31T16:00:09.000Z' },
    ],
  },
  {
    id: 'ho-0002',
    ownerPartyId: DEMO_OWNER_PARTY_ID,
    mandateCaseId: 'mc-0202',
    rentalUnitId: 'ru-0202',
    address: '臺北市中山區民生東路三段 51 號 7 樓',
    unitLabel: '7 樓',
    leaseCaseId: 'lc-0202',
    from: { orgId: SUILIN.orgId, name: SUILIN.name },
    target: { kind: 'mandatary', orgId: BEICHEN.orgId, name: BEICHEN.name },
    state: 'released',
    effectiveDate: '2026-11-08',
    acknowledgedMissing: [],
    manual: FILLED,
    ...frozen('ho-0002', 'ru-0202', RELEASED_SOURCE, FILLED),
    createdAt: '2026-10-28T01:00:00.000Z',
    events: [
      { type: 'handover_draft_created', at: '2026-10-28T01:00:00.000Z' },
      { type: 'handover_owner_confirm', at: '2026-10-28T01:20:00.000Z' },
      { type: 'handover_accept', at: '2026-10-30T08:00:00.000Z' },
      { type: 'handover_release', at: '2026-11-07T16:00:04.000Z' },
    ],
  },
];

export function demoHandoverSeed(): HandoverSeed {
  return {
    mandateCases: [
      {
        id: 'mc-0101',
        ownerPartyId: DEMO_OWNER_PARTY_ID,
        mandatary: QINGHE,
        status: 'active',
        units: [
          {
            rentalUnitId: 'ru-0101',
            address: '臺北市大安區和平東路二段 96 巷 12 號 3 樓',
            unitLabel: '3 樓',
            leaseCaseId: 'lc-0101',
          },
          {
            rentalUnitId: 'ru-0102',
            address: '臺北市大安區和平東路二段 96 巷 12 號 5 樓',
            unitLabel: '5 樓',
            leaseCaseId: 'lc-0102',
          },
          {
            rentalUnitId: 'ru-0103',
            address: '新北市板橋區文化路一段 210 號 8 樓之 2',
            unitLabel: '8 樓之 2',
            leaseCaseId: null,
          },
        ],
      },
      {
        id: 'mc-0201',
        ownerPartyId: DEMO_OWNER_PARTY_ID,
        mandatary: BEICHEN,
        status: 'active',
        units: [
          {
            rentalUnitId: 'ru-0201',
            address: '臺北市中山區民生東路三段 51 號 4 樓',
            unitLabel: '4 樓',
            leaseCaseId: 'lc-0201',
          },
        ],
      },
    ],
    unitSources: UNIT_SOURCES,
    receiverCandidates: [
      {
        ownerPartyId: DEMO_OWNER_PARTY_ID,
        candidates: [
          { entity: BEICHEN, mandatedUnitIds: ['ru-0101', 'ru-0102', 'ru-0103', 'ru-0201'], paperContractUnitIds: [] },
          { entity: YUANFAN, mandatedUnitIds: [], paperContractUnitIds: ['ru-0101', 'ru-0102', 'ru-0103'] },
          { entity: YAOSHI, mandatedUnitIds: [], paperContractUnitIds: [] },
        ],
      },
    ],
    paymentAccounts: [
      {
        ownerPartyId: DEMO_OWNER_PARTY_ID,
        accounts: [
          { id: 'pa-owner-1', label: '示範銀行 ****1234', holderName: '王美玲' },
          { id: 'pa-owner-2', label: '範例商業銀行 ****5678', holderName: '王美玲' },
        ],
      },
    ],
    handovers: HANDOVERS,
  };
}
