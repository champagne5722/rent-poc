// 移交包匯出檔的組裝（MIL-98、ADR-0024 決議 6、7）。純函式，沒有 I/O。
// 輸入是凍結的快照、記錄的雜湊與已簽 PDF 位元組，輸出是固定順序的檔案清單與 ZIP。
// JSON 一律以鍵排序輸出，同一快照不論從哪裡讀回，都產生同一份 index.json。
// 用 node:crypto，只給 server 端用。
import { createHash } from 'node:crypto';
import { zipSync, type Zippable } from 'fflate';
import type { HandoverSnapshot, SignedDocRef } from './snapshot';
import { hashHandoverSnapshot, sortKeys } from './snapshot-hash';

export const HANDOVER_PACKAGE_FORMAT = 'rentpoc.handover-package';
export const HANDOVER_PACKAGE_FORMAT_VERSION = 1;

export interface HandoverPackageInput {
  handover: {
    id: string;
    rentalUnitId: string;
    address: string;
    from: { orgId: string; name: string };
    /** 改自管時接收方是屋主組織。 */
    to: { kind: 'mandatary'; orgId: string; name: string } | { kind: 'self_managed' };
    effectiveDate: string | null;
    /** 接收側完成的時間（ISO 8601）。ZIP 內檔案的修改時間用它，讓同一份移交包壓出同樣的位元組。 */
    completedAt: string;
  };
  snapshot: HandoverSnapshot;
  /** 交出側生效時記錄的雜湊。匯出時重算比對。 */
  snapshotHash: string;
  /** 已簽 PDF 的位元組，鍵是文件 ID。 */
  signedPdfs: Readonly<Record<string, Uint8Array>>;
}

export type SignedDocumentStatus = 'included' | 'missing' | 'hash_mismatch';

export interface SignedDocumentEntry {
  /** `類別.項目`，與缺項鍵同一套。 */
  itemKey: string;
  docId: string;
  /** 沒有放進 ZIP 時是 null。 */
  path: string | null;
  /** 快照記錄的 SHA-256。 */
  expectedSha256: string;
  /** 放進 ZIP 的位元組算出的 SHA-256。沒有檔案時是 null。 */
  sha256: string | null;
  status: SignedDocumentStatus;
}

export interface HandoverPackageFile {
  path: string;
  bytes: Uint8Array;
}

export interface HandoverPackage {
  files: HandoverPackageFile[];
  signedDocuments: SignedDocumentEntry[];
  /** ZIP 內檔案的修改時間，等於接收側完成的時間。 */
  modifiedAt: string;
}

/** 快照「人」這一類裡要附 PDF 的項目，依快照順序。 */
const SIGNED_ITEMS: { itemKey: string; filePrefix: string }[] = [
  { itemKey: 'people.management_contract', filePrefix: 'management-contract' },
  { itemKey: 'people.lease_contract', filePrefix: 'lease-contract' },
];

const encoder = new TextEncoder();

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** 鍵排序、兩格縮排、結尾換行的 JSON。 */
function jsonFile(path: string, value: unknown): HandoverPackageFile {
  return { path, bytes: encoder.encode(`${JSON.stringify(sortKeys(value), null, 2)}\n`) };
}

function presentValue(snapshot: HandoverSnapshot, itemKey: string): unknown {
  const [categoryKey, key] = itemKey.split('.');
  const item = snapshot.categories.find((c) => c.key === categoryKey)?.items.find((i) => i.key === key);
  return item?.status === 'present' ? item.value : null;
}

export function buildHandoverPackage(input: HandoverPackageInput): HandoverPackage {
  const { handover, snapshot, snapshotHash, signedPdfs } = input;

  const pdfFiles: HandoverPackageFile[] = [];
  const signedDocuments: SignedDocumentEntry[] = [];
  for (const { itemKey, filePrefix } of SIGNED_ITEMS) {
    const ref = presentValue(snapshot, itemKey) as SignedDocRef | null;
    if (!ref) continue;
    const bytes = signedPdfs[ref.id];
    if (!bytes) {
      signedDocuments.push({
        itemKey,
        docId: ref.id,
        path: null,
        expectedSha256: ref.signedPdfSha256,
        sha256: null,
        status: 'missing',
      });
      continue;
    }
    const path = `signed/${filePrefix}-${ref.id}.pdf`;
    const actual = sha256(bytes);
    pdfFiles.push({ path, bytes });
    signedDocuments.push({
      itemKey,
      docId: ref.id,
      path,
      expectedSha256: ref.signedPdfSha256,
      sha256: actual,
      status: actual === ref.signedPdfSha256 ? 'included' : 'hash_mismatch',
    });
  }

  const money = snapshot.categories.find((c) => c.key === 'money');
  const ledger = {
    handoverId: handover.id,
    rentalUnitId: handover.rentalUnitId,
    // 平台只記鏡像帳，不經手錢（README 第 1 節定案 3）
    basis: '鏡像帳，金額以銀行紀錄為準',
    items: (money?.items ?? []).map((item) => ({
      key: item.key,
      label: item.label,
      status: item.status,
      value: item.value,
    })),
  };

  const index = {
    format: HANDOVER_PACKAGE_FORMAT,
    formatVersion: HANDOVER_PACKAGE_FORMAT_VERSION,
    handoverId: handover.id,
    rentalUnitId: handover.rentalUnitId,
    address: handover.address,
    from: handover.from,
    to: handover.to,
    effectiveDate: handover.effectiveDate,
    snapshotHash: {
      algorithm: 'SHA-256',
      canonicalization: 'sorted-keys-json',
      value: snapshotHash,
      matchesSnapshot: hashHandoverSnapshot(snapshot) === snapshotHash,
    },
    // 快照原樣放入：六類索引與缺項都在裡面，驗證時對它重算雜湊
    snapshot,
    ledgerSnapshot: 'ledger-snapshot.json',
    signedDocuments,
  };

  return {
    files: [jsonFile('index.json', index), jsonFile('ledger-snapshot.json', ledger), ...pdfFiles],
    signedDocuments,
    modifiedAt: handover.completedAt,
  };
}

export function zipHandoverPackage(pkg: HandoverPackage): Uint8Array {
  const entries: Zippable = {};
  for (const file of pkg.files) entries[file.path] = [file.bytes, { mtime: pkg.modifiedAt }];
  return zipSync(entries);
}
