import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildHandoverPackage, zipHandoverPackage, type HandoverPackageInput } from './package';
import { buildHandoverSnapshot, type HandoverSnapshotFacts } from './snapshot';
import { hashHandoverSnapshot } from './snapshot-hash';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// 測試用的已簽 PDF 位元組。SHA-256 以 `printf '%s' ... | shasum -a 256` 算出，當獨立對照
const MC_PDF = encoder.encode('%PDF-1.4 management');
const MC_SHA = 'cb02ffb287f62708792fb9c413821246fb0a681db7c4a43d1650b21054ac2722';
const LC_PDF = encoder.encode('%PDF-1.4 lease');
const LC_SHA = 'f23a5b609574b38042037a84b6c134037862915e15666cbbe370612d494b59ed';

function facts(overrides: Partial<HandoverSnapshotFacts> = {}): HandoverSnapshotFacts {
  return {
    handoverId: 'ho-1',
    rentalUnitId: 'ru-1',
    hasLeaseCase: true,
    title: { leaseAuthorityStatus: 'verified', transcriptFetchedAt: '2026-10-01' },
    people: {
      managementContract: { id: 'mc-1', signedPdfSha256: MC_SHA },
      leaseContract: { id: 'lc-1', signedPdfSha256: LC_SHA },
    },
    condition: { moveInRecord: { id: 'mi-1', name: '點交紀錄' }, conditionAttachments: [], equipmentAttachments: [] },
    money: { depositBalance: 36000, prepaidRentBalance: 12000, unpaidPeriods: [], uncollectedRemittance: 0 },
    repairs: [],
    manual: { keyHandover: '大門鑰匙 2 把', accessCardHandover: '', committeeContact: '' },
    ...overrides,
  };
}

function input(overrides: Partial<HandoverPackageInput> = {}): HandoverPackageInput {
  const snapshot = buildHandoverSnapshot(facts());
  return {
    handover: {
      id: 'ho-1',
      rentalUnitId: 'ru-1',
      address: '臺北市中山區民生東路三段 51 號 7 樓',
      from: { orgId: 'org-a', name: '交出公司' },
      to: { kind: 'mandatary', orgId: 'org-b', name: '接收公司' },
      effectiveDate: '2026-11-08',
      completedAt: '2026-11-07T16:00:09.000Z',
    },
    snapshot,
    snapshotHash: hashHandoverSnapshot(snapshot),
    signedPdfs: { 'mc-1': MC_PDF, 'lc-1': LC_PDF },
    ...overrides,
  };
}

const text = (bytes: Uint8Array) => decoder.decode(bytes);
const fileOf = (pkg: ReturnType<typeof buildHandoverPackage>, path: string) => pkg.files.find((f) => f.path === path);
const indexOf = (pkg: ReturnType<typeof buildHandoverPackage>) => JSON.parse(text(fileOf(pkg, 'index.json')!.bytes));

/** 把物件的鍵順序整個反過來，模擬從資料庫讀回、鍵順序不同的快照。 */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([k, v]) => [k, reverseKeys(v)]),
    );
  }
  return value;
}

describe('buildHandoverPackage', () => {
  it('同一快照產生同一份 index.json，鍵的順序不同也一樣', () => {
    const a = input();
    const b = input({ snapshot: reverseKeys(structuredClone(a.snapshot)) as typeof a.snapshot });
    const first = text(fileOf(buildHandoverPackage(a), 'index.json')!.bytes);
    expect(text(fileOf(buildHandoverPackage(a), 'index.json')!.bytes)).toBe(first);
    expect(text(fileOf(buildHandoverPackage(b), 'index.json')!.bytes)).toBe(first);
  });

  it('index.json 有六類索引、缺項與快照雜湊，雜湊能從索引內的快照重算', () => {
    const index = indexOf(buildHandoverPackage(input()));
    expect(index.snapshot.categories.map((c: { key: string }) => c.key)).toEqual([
      'title',
      'people',
      'condition',
      'money',
      'physical',
      'admin',
    ]);
    expect(index.snapshot.missing.map((m: { key: string }) => m.key)).toEqual([
      'condition.condition_attachments',
      'condition.equipment_attachments',
      'physical.access_cards',
      'admin.committee_contact',
    ]);
    expect(index.snapshotHash).toEqual({
      algorithm: 'SHA-256',
      canonicalization: 'sorted-keys-json',
      value: input().snapshotHash,
      matchesSnapshot: true,
    });
    expect(hashHandoverSnapshot(index.snapshot)).toBe(index.snapshotHash.value);
  });

  it('記錄的雜湊與快照不符時，index.json 標示不符', () => {
    const index = indexOf(buildHandoverPackage(input({ snapshotHash: '0'.repeat(64) })));
    expect(index.snapshotHash.matchesSnapshot).toBe(false);
  });

  it('ledger-snapshot.json 是「錢」這一類的帳務快照', () => {
    const pkg = buildHandoverPackage(input());
    const ledger = JSON.parse(text(fileOf(pkg, 'ledger-snapshot.json')!.bytes));
    expect(ledger.handoverId).toBe('ho-1');
    expect(ledger.items).toEqual([
      { key: 'deposit', label: '押金餘額', status: 'present', value: 36000 },
      { key: 'prepaid_rent', label: '預收租金餘額', status: 'present', value: 12000 },
      { key: 'unpaid_periods', label: '未足額期別', status: 'present', value: [] },
      { key: 'uncollected_remittance', label: '代收未交付', status: 'present', value: 0 },
    ]);
  });

  it('已簽 PDF 原樣放進 signed/，索引記下每個檔案的 SHA-256', () => {
    const pkg = buildHandoverPackage(input());
    expect(pkg.files.map((f) => f.path)).toEqual([
      'index.json',
      'ledger-snapshot.json',
      'signed/management-contract-mc-1.pdf',
      'signed/lease-contract-lc-1.pdf',
    ]);
    expect(fileOf(pkg, 'signed/lease-contract-lc-1.pdf')!.bytes).toEqual(LC_PDF);
    expect(indexOf(pkg).signedDocuments).toEqual([
      {
        itemKey: 'people.management_contract',
        docId: 'mc-1',
        path: 'signed/management-contract-mc-1.pdf',
        expectedSha256: MC_SHA,
        sha256: MC_SHA,
        status: 'included',
      },
      {
        itemKey: 'people.lease_contract',
        docId: 'lc-1',
        path: 'signed/lease-contract-lc-1.pdf',
        expectedSha256: LC_SHA,
        sha256: LC_SHA,
        status: 'included',
      },
    ]);
  });

  it('找不到 PDF 時不放檔案並標示缺檔，位元組與快照記錄的雜湊不符時標示不符', () => {
    const pkg = buildHandoverPackage(input({ signedPdfs: { 'mc-1': LC_PDF } }));
    expect(pkg.files.map((f) => f.path)).toEqual([
      'index.json',
      'ledger-snapshot.json',
      'signed/management-contract-mc-1.pdf',
    ]);
    const docs = indexOf(pkg).signedDocuments;
    expect(docs.map((d: { status: string }) => d.status)).toEqual(['hash_mismatch', 'missing']);
    expect(docs[0].sha256).toBe(LC_SHA);
    expect(docs[1]).toMatchObject({ path: null, sha256: null });
  });

  it('沒有租賃案件時只有委託管理合約的 PDF', () => {
    const snapshot = buildHandoverSnapshot(facts({ hasLeaseCase: false }));
    const pkg = buildHandoverPackage(input({ snapshot, snapshotHash: hashHandoverSnapshot(snapshot) }));
    expect(pkg.files.map((f) => f.path)).toEqual([
      'index.json',
      'ledger-snapshot.json',
      'signed/management-contract-mc-1.pdf',
    ]);
  });
});

describe('zipHandoverPackage', () => {
  it('ZIP 解開後是同樣的檔案與位元組', () => {
    const pkg = buildHandoverPackage(input());
    const unzipped = unzipSync(zipHandoverPackage(pkg));
    expect(Object.keys(unzipped)).toEqual(pkg.files.map((f) => f.path));
    for (const file of pkg.files) expect(unzipped[file.path]).toEqual(file.bytes);
  });

  it('同一份移交包壓出同樣的位元組', () => {
    expect(zipHandoverPackage(buildHandoverPackage(input()))).toEqual(
      zipHandoverPackage(buildHandoverPackage(input())),
    );
  });
});
