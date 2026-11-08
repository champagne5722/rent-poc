// 移交畫面的假資料。公司名、人名、地址、帳號都是虛構的。
// 屋主是 owner-session.ts 的第一位 seed 屋主。涵蓋：兩個代管租賃案件、一個簽署中被擋下的案件、
// 一個委託標的清單上的空置單位、一個交出側已完成的移交、一個已完成的移交。
// MIL-98 加上後台用的資料，後台預設身分是北辰（practice-org-session.ts）：
// 兩個等北辰接手的移交（一個能接手、一個被擋下），以及一個北辰交出的已完成移交（唯讀副本）。
import { createHash } from 'node:crypto';
import { demoSignedPdf } from './demo-pdf';
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

/** 已簽 PDF 的 SHA-256，從 demo-pdf.ts 產生的位元組算出，匯出時能比對一致。 */
const sha = (docId: string) => createHash('sha256').update(demoSignedPdf(docId)).digest('hex');

const SIGNED_DOC_IDS = [
  'mc-0101',
  'lc-0101',
  'mc-0201',
  'lc-0201',
  'mc-0202',
  'lc-0202',
  'lc-0203',
  'lc-0204',
  'mc-0203',
  'lc-0205',
];

const UNIT_SOURCES: UnitHandoverSource[] = [
  {
    rentalUnitId: 'ru-0101',
    hasActiveSigningTask: false,
    currentAccountHolder: QINGHE.name,
    snapshot: {
      hasLeaseCase: true,
      title: { leaseAuthorityStatus: 'verified', transcriptFetchedAt: '2026-08-14' },
      people: {
        managementContract: { id: 'mc-0101', signedPdfSha256: sha('mc-0101') },
        leaseContract: { id: 'lc-0101', signedPdfSha256: sha('lc-0101') },
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
        managementContract: { id: 'mc-0101', signedPdfSha256: sha('mc-0101') },
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
      people: { managementContract: { id: 'mc-0101', signedPdfSha256: sha('mc-0101') }, leaseContract: null },
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
        managementContract: { id: 'mc-0201', signedPdfSha256: sha('mc-0201') },
        leaseContract: { id: 'lc-0201', signedPdfSha256: sha('lc-0201') },
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
  {
    // ho-0003：穗林交給北辰，等北辰接手。目前收款帳戶在穗林名下，北辰接手時持有人會變更
    rentalUnitId: 'ru-0203',
    hasActiveSigningTask: false,
    currentAccountHolder: SUILIN.name,
    snapshot: {
      hasLeaseCase: true,
      title: { leaseAuthorityStatus: 'verified', transcriptFetchedAt: '2026-09-20' },
      people: {
        managementContract: { id: 'mc-0202', signedPdfSha256: sha('mc-0202') },
        leaseContract: { id: 'lc-0203', signedPdfSha256: sha('lc-0203') },
      },
      condition: {
        moveInRecord: { id: 'mi-0203', name: '入住點交紀錄 2026-02-01' },
        conditionAttachments: [{ id: 'att-0205', name: '現況照片 14 張' }],
        equipmentAttachments: [{ id: 'att-0206', name: '設備清單' }],
      },
      money: { depositBalance: 38000, prepaidRentBalance: 19000, unpaidPeriods: [], uncollectedRemittance: 0 },
      repairs: [{ id: 'rr-0203', title: '冷氣不冷', status: 'reported' }],
    },
  },
  {
    // ho-0004：屋主確認後才開始簽署，接手時被擋下
    rentalUnitId: 'ru-0204',
    hasActiveSigningTask: true,
    currentAccountHolder: SUILIN.name,
    snapshot: {
      hasLeaseCase: true,
      title: { leaseAuthorityStatus: 'verified', transcriptFetchedAt: '2026-09-20' },
      people: {
        managementContract: { id: 'mc-0202', signedPdfSha256: sha('mc-0202') },
        leaseContract: { id: 'lc-0204', signedPdfSha256: sha('lc-0204') },
      },
      condition: { moveInRecord: null, conditionAttachments: [], equipmentAttachments: [] },
      money: { depositBalance: 30000, prepaidRentBalance: 0, unpaidPeriods: [], uncollectedRemittance: 0 },
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
    managementContract: { id: 'mc-0202', signedPdfSha256: sha('mc-0202') },
    leaseContract: { id: 'lc-0202', signedPdfSha256: sha('lc-0202') },
  },
  condition: {
    moveInRecord: { id: 'mi-0202', name: '入住點交紀錄 2025-11-01' },
    conditionAttachments: [{ id: 'att-0203', name: '現況照片 9 張' }],
    equipmentAttachments: [{ id: 'att-0204', name: '設備清單' }],
  },
  money: { depositBalance: 40000, prepaidRentBalance: 0, unpaidPeriods: [], uncollectedRemittance: 0 },
  repairs: [],
};

const OUTGOING_SOURCE: UnitHandoverSource['snapshot'] = {
  hasLeaseCase: true,
  title: { leaseAuthorityStatus: 'verified', transcriptFetchedAt: '2026-08-30' },
  people: {
    managementContract: { id: 'mc-0203', signedPdfSha256: sha('mc-0203') },
    leaseContract: { id: 'lc-0205', signedPdfSha256: sha('lc-0205') },
  },
  condition: {
    moveInRecord: { id: 'mi-0205', name: '入住點交紀錄 2025-07-01' },
    conditionAttachments: [{ id: 'att-0207', name: '現況照片 10 張' }],
    equipmentAttachments: [],
  },
  money: { depositBalance: 34000, prepaidRentBalance: 17000, unpaidPeriods: [], uncollectedRemittance: 0 },
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
  {
    id: 'ho-0003',
    ownerPartyId: DEMO_OWNER_PARTY_ID,
    mandateCaseId: 'mc-0202',
    rentalUnitId: 'ru-0203',
    address: '臺北市中山區民生東路三段 51 號 8 樓',
    unitLabel: '8 樓',
    leaseCaseId: 'lc-0203',
    from: { orgId: SUILIN.orgId, name: SUILIN.name },
    target: { kind: 'mandatary', orgId: BEICHEN.orgId, name: BEICHEN.name },
    state: 'owner_confirmed',
    effectiveDate: null,
    acknowledgedMissing: [],
    manual: FILLED,
    frozenSnapshot: null,
    snapshotHash: null,
    createdAt: '2026-11-05T02:00:00.000Z',
    events: [
      { type: 'handover_draft_created', at: '2026-11-05T02:00:00.000Z' },
      { type: 'handover_owner_confirm', at: '2026-11-05T02:30:00.000Z' },
    ],
  },
  {
    id: 'ho-0004',
    ownerPartyId: DEMO_OWNER_PARTY_ID,
    mandateCaseId: 'mc-0202',
    rentalUnitId: 'ru-0204',
    address: '臺北市中山區民生東路三段 51 號 9 樓',
    unitLabel: '9 樓',
    leaseCaseId: 'lc-0204',
    from: { orgId: SUILIN.orgId, name: SUILIN.name },
    target: { kind: 'mandatary', orgId: BEICHEN.orgId, name: BEICHEN.name },
    state: 'owner_confirmed',
    effectiveDate: null,
    acknowledgedMissing: ['condition.move_in', 'condition.condition_attachments', 'condition.equipment_attachments'],
    manual: FILLED,
    frozenSnapshot: null,
    snapshotHash: null,
    createdAt: '2026-11-05T02:05:00.000Z',
    events: [
      { type: 'handover_draft_created', at: '2026-11-05T02:05:00.000Z' },
      { type: 'handover_owner_confirm', at: '2026-11-05T02:35:00.000Z' },
    ],
  },
  {
    // 北辰交出的已完成移交：北辰在後台只看得到快照的唯讀副本
    id: 'ho-0005',
    ownerPartyId: DEMO_OWNER_PARTY_ID,
    mandateCaseId: 'mc-0203',
    rentalUnitId: 'ru-0205',
    address: '新北市永和區永貞路 88 號 2 樓',
    unitLabel: '2 樓',
    leaseCaseId: 'lc-0205',
    from: { orgId: BEICHEN.orgId, name: BEICHEN.name },
    target: { kind: 'mandatary', orgId: YAOSHI.orgId, name: YAOSHI.name },
    state: 'completed',
    effectiveDate: '2026-10-01',
    acknowledgedMissing: ['condition.equipment_attachments'],
    manual: FILLED,
    ...frozen('ho-0005', 'ru-0205', OUTGOING_SOURCE, FILLED),
    receiverAccount: {
      paymentAccountId: 'pa-yaoshi-1',
      label: '範例商業銀行 ****3305',
      holderName: YAOSHI.name,
      evidence: { note: '押金與預收租金已由北辰匯入曜石的收款帳戶，附匯款單號 0930-118。', file: null },
    },
    createdAt: '2026-09-10T02:00:00.000Z',
    events: [
      { type: 'handover_draft_created', at: '2026-09-10T02:00:00.000Z' },
      { type: 'handover_owner_confirm', at: '2026-09-10T03:00:00.000Z' },
      { type: 'handover_accept', at: '2026-09-15T06:00:00.000Z' },
      { type: 'handover_release', at: '2026-09-30T16:00:04.000Z' },
      { type: 'handover_receive', at: '2026-09-30T16:00:08.000Z' },
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
          // 北辰涵蓋 ru-0204 的委託管理合約還沒簽，接手時被擋下
          {
            entity: BEICHEN,
            mandatedUnitIds: ['ru-0101', 'ru-0102', 'ru-0103', 'ru-0201', 'ru-0203'],
            paperContractUnitIds: [],
          },
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
    orgPaymentAccounts: [
      {
        orgId: BEICHEN.orgId,
        accounts: [
          { id: 'pa-beichen-1', label: '示範銀行 ****8801', holderName: BEICHEN.name },
          { id: 'pa-beichen-2', label: '範例商業銀行 ****2290', holderName: BEICHEN.name },
        ],
      },
      {
        orgId: SUILIN.orgId,
        accounts: [{ id: 'pa-suilin-1', label: '示範銀行 ****4417', holderName: SUILIN.name }],
      },
      {
        orgId: YAOSHI.orgId,
        accounts: [{ id: 'pa-yaoshi-1', label: '範例商業銀行 ****3305', holderName: YAOSHI.name }],
      },
    ],
    signedPdfs: Object.fromEntries(SIGNED_DOC_IDS.map((id) => [id, demoSignedPdf(id)])),
    handovers: HANDOVERS,
  };
}
