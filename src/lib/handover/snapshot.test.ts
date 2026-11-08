import { describe, expect, it } from 'vitest';
import { buildHandoverSnapshot, type HandoverSnapshotFacts } from './snapshot';
import { canonicalJson, hashHandoverSnapshot } from './snapshot-hash';

// 有租賃案件、六類資料齊全的租賃單位
const COMPLETE: HandoverSnapshotFacts = {
  handoverId: 'ho-1',
  rentalUnitId: 'ru-1',
  hasLeaseCase: true,
  title: { leaseAuthorityStatus: 'verified', transcriptFetchedAt: '2026-10-01' },
  people: {
    managementContract: { id: 'mc-1', signedPdfSha256: 'a'.repeat(64) },
    leaseContract: { id: 'lc-1', signedPdfSha256: 'b'.repeat(64) },
  },
  condition: {
    moveInRecord: { id: 'mi-1', name: '點交紀錄' },
    conditionAttachments: [{ id: 'att-1', name: '現況照片' }],
    equipmentAttachments: [{ id: 'att-2', name: '設備清單' }],
  },
  money: {
    depositBalance: 36000,
    prepaidRentBalance: 0,
    unpaidPeriods: [],
    uncollectedRemittance: 0,
  },
  repairs: [],
  manual: { keyHandover: '大門鑰匙 2 把', accessCardHandover: '門禁卡 1 張', committeeContact: '管委會 02-2345-6789' },
};

describe('buildHandoverSnapshot', () => {
  it('產出六類索引，順序與名稱固定', () => {
    const snapshot = buildHandoverSnapshot(COMPLETE);
    expect(snapshot.categories.map((c) => [c.key, c.label])).toEqual([
      ['title', '權屬'],
      ['people', '人'],
      ['condition', '屋況'],
      ['money', '錢'],
      ['physical', '實物'],
      ['admin', '行政'],
    ]);
  });

  it('資料齊全時沒有缺項', () => {
    expect(buildHandoverSnapshot(COMPLETE).missing).toEqual([]);
  });

  it('實物與行政的手填欄位沒填時列為缺項，只有空白也算沒填', () => {
    const snapshot = buildHandoverSnapshot({
      ...COMPLETE,
      manual: { keyHandover: '', accessCardHandover: '   ', committeeContact: '' },
    });
    expect(snapshot.missing).toEqual([
      { key: 'physical.keys', category: '實物', label: '鑰匙交付紀錄' },
      { key: 'physical.access_cards', category: '實物', label: '門禁卡交付紀錄' },
      { key: 'admin.committee_contact', category: '行政', label: '管委會窗口' },
    ]);
  });

  it('來源沒有資料的項目列為缺項', () => {
    const snapshot = buildHandoverSnapshot({
      ...COMPLETE,
      title: { leaseAuthorityStatus: null, transcriptFetchedAt: null },
      condition: { ...COMPLETE.condition, conditionAttachments: [] },
      money: { ...COMPLETE.money, depositBalance: null },
      repairs: null,
    });
    expect(snapshot.missing.map((m) => m.key)).toEqual([
      'title.lease_authority',
      'title.transcript',
      'condition.condition_attachments',
      'money.deposit',
      'admin.repairs',
    ]);
  });

  it('沒有欠費與沒有修繕不算缺項', () => {
    const snapshot = buildHandoverSnapshot(COMPLETE);
    const money = snapshot.categories.find((c) => c.key === 'money')!;
    expect(money.items.find((i) => i.key === 'unpaid_periods')).toMatchObject({ status: 'present', value: [] });
  });

  it('委託標的清單上沒有租賃案件的單位：租約、點交與帳務不適用，不列缺項', () => {
    const snapshot = buildHandoverSnapshot({
      ...COMPLETE,
      hasLeaseCase: false,
      people: { ...COMPLETE.people, leaseContract: null },
      condition: { moveInRecord: null, conditionAttachments: [], equipmentAttachments: [] },
      money: { depositBalance: null, prepaidRentBalance: null, unpaidPeriods: null, uncollectedRemittance: null },
    });
    expect(snapshot.missing).toEqual([]);
    const statuses = snapshot.categories.flatMap((c) => c.items.map((i) => `${c.key}.${i.key}:${i.status}`));
    expect(statuses).toContain('people.lease_contract:not_applicable');
    expect(statuses).toContain('money.deposit:not_applicable');
    expect(statuses).toContain('title.lease_authority:present');
  });
});

describe('快照雜湊', () => {
  it('canonical JSON 以鍵排序，與鍵的寫入順序無關', () => {
    expect(canonicalJson({ b: [2, { d: null, c: '移交' }], a: 1 })).toBe('{"a":1,"b":[2,{"c":"移交","d":null}]}');
  });

  it('SHA-256 與 shasum 對同一份 canonical JSON 的結果相同', () => {
    // printf '%s' '{"a":1,"b":[2,{"c":"移交","d":null}]}' | shasum -a 256
    expect(hashHandoverSnapshot({ b: [2, { d: null, c: '移交' }], a: 1 })).toBe(
      '052b44e704960bf8d5e758637f152e1bd95013ae386e1466f5ff9749d3b66125',
    );
  });

  it('同一輸入同一雜湊，改一個欄位後雜湊不同', () => {
    const hash = hashHandoverSnapshot(buildHandoverSnapshot(COMPLETE));
    expect(hashHandoverSnapshot(buildHandoverSnapshot(structuredClone(COMPLETE)))).toBe(hash);
    const changed = buildHandoverSnapshot({ ...COMPLETE, money: { ...COMPLETE.money, depositBalance: 35999 } });
    expect(hashHandoverSnapshot(changed)).not.toBe(hash);
  });
});
