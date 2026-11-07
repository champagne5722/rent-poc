import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureSchema, getContract, setDb } from './db';
import { defaultFieldRect } from './signature-layout';
import { contractSignerSequence } from './signing';
import { createDottedSignProvider, type DottedSignRequest } from './signing-module/dottedsign-adapter';
import type { SignatureField } from './types';

// 簽署角色資料轉換（MIL-55、ADR-0010 決議 6）。
// 下列座標是改名前的程式碼實際算出的快照，用來證明既有合約的簽名框位置不變。
const A4 = { width: 595.28, height: 841.89 };

const LEGACY_LANDLORD_FIELD = {
  id: 'l1',
  signer: 'landlord',
  page: 1,
  x: 0.162948528423599,
  y: 0.15916568672867001,
  w: 0.3023787125386373,
  h: 0.052263359821354334,
};
const LEGACY_TENANT_FIELD = {
  id: 't1',
  signer: 'tenant',
  page: 1,
  x: 0.162948528423599,
  y: 0.2803216572236278,
  w: 0.3023787125386373,
  h: 0.052263359821354334,
};

const LEGACY_FIELDS = JSON.stringify({
  landlordName: '林房東',
  landlordEmail: 'landlord@example.com',
  tenantName: '王租客',
  tenantEmail: 'tenant@example.com',
  // 修繕責任也用 landlord、tenant，屬於另一個值域，轉換不得碰
  equipmentAnnex: [{ name: '冷氣', quantity: 1, repair: 'landlord', note: 'tenant 自購' }],
});

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  ensureSchema(db);
  setDb(db);
});

afterEach(() => {
  setDb(null);
  db.close();
});

function insertContract(signatureFields: string, updatedAt: string | null = '2026-01-02 03:04:05'): number {
  const result = db
    .prepare(
      `INSERT INTO contracts (status, fields, signature_fields, dottedsign_task_id, updated_at)
       VALUES ('draft', ?, ?, 'task-1', ?)`
    )
    .run(LEGACY_FIELDS, signatureFields, updatedAt);
  return Number(result.lastInsertRowid);
}

function storedRow(id: number) {
  return db.prepare('SELECT * FROM contracts WHERE id = ?').get(id);
}

describe('既有合約的簽署角色轉換', () => {
  it('landlord 改成 party_a、tenant 改成 party_b，頁碼與座標不變', () => {
    const id = insertContract(JSON.stringify([LEGACY_LANDLORD_FIELD, LEGACY_TENANT_FIELD]));

    ensureSchema(db);

    expect(getContract(id)?.signature_fields).toEqual([
      { ...LEGACY_LANDLORD_FIELD, signer: 'party_a' },
      { ...LEGACY_TENANT_FIELD, signer: 'party_b' },
    ]);
  });

  it('第二次執行不改任何資料', () => {
    const id = insertContract(JSON.stringify([LEGACY_LANDLORD_FIELD, LEGACY_TENANT_FIELD]));
    ensureSchema(db);
    const afterFirst = storedRow(id);
    const changesAfterFirst = db.prepare('SELECT total_changes() AS n').get();

    ensureSchema(db);

    expect(storedRow(id)).toEqual(afterFirst);
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changesAfterFirst);
  });

  it('只動 signer：合約欄位、修繕責任與更新時間都不變', () => {
    const id = insertContract(JSON.stringify([LEGACY_TENANT_FIELD]));
    const before = storedRow(id) as { fields: string; updated_at: string };

    ensureSchema(db);

    expect(storedRow(id)).toMatchObject({ fields: before.fields, updated_at: before.updated_at });
  });

  it('合約歷程的行為者不轉換', () => {
    const id = insertContract(JSON.stringify([LEGACY_LANDLORD_FIELD]));
    db.prepare("INSERT INTO contract_events (contract_id, type, actor) VALUES (?, 'created', 'landlord')").run(id);

    ensureSchema(db);

    expect(db.prepare('SELECT actor FROM contract_events WHERE contract_id = ?').get(id)).toEqual({
      actor: 'landlord',
    });
  });

  it('新舊值混在同一份合約時，只改舊值', () => {
    const id = insertContract(
      JSON.stringify([{ ...LEGACY_LANDLORD_FIELD, signer: 'party_a' }, LEGACY_TENANT_FIELD])
    );

    ensureSchema(db);

    expect(getContract(id)?.signature_fields.map((f) => f.signer)).toEqual(['party_a', 'party_b']);
  });

  it('沒有舊值的合約，文字內容一個字元都不改', () => {
    const empty = insertContract('[]');
    const spaced = insertContract('[ {"id":"p1", "signer":"party_a", "page":0, "x":0, "y":0, "w":1, "h":1} ]');
    const before = [storedRow(empty), storedRow(spaced)];

    ensureSchema(db);

    expect([storedRow(empty), storedRow(spaced)]).toEqual(before);
  });

  it('內容不是合法 JSON 陣列的列維持原樣，也不擋住開檔', () => {
    const broken = insertContract('{not json');
    const notArray = insertContract('{"signer":"landlord"}');

    expect(() => ensureSchema(db)).not.toThrow();

    expect(storedRow(broken)).toMatchObject({ signature_fields: '{not json' });
    expect(storedRow(notArray)).toMatchObject({ signature_fields: '{"signer":"landlord"}' });
  });
});

describe('轉換後的簽名框位置快照', () => {
  it('送給點點簽的 PDF 座標與轉換前相同', async () => {
    const id = insertContract(JSON.stringify([LEGACY_LANDLORD_FIELD, LEGACY_TENANT_FIELD]));
    ensureSchema(db);

    const calls: { body: { stages: { email: string; field_settings: { page: number; coord: number[] }[] }[] } }[] = [];
    const request: DottedSignRequest = async (_path, init) => {
      calls.push({ body: JSON.parse(String(init?.body)) });
      return { data: { task_id: 1 } };
    };
    await createDottedSignProvider({ request, clientSecret: 's' }).createTask({
      subject: { type: 'contract', id },
      document: { fileName: 'a', pdf: new Uint8Array([1]), pageSize: A4 },
      signers: contractSignerSequence(getContract(id)!),
    });

    expect(
      calls[0].body.stages.map((s) => ({
        email: s.email,
        fields: s.field_settings.map((f) => ({ page: f.page, coord: f.coord })),
      }))
    ).toEqual([
      { email: 'tenant@example.com', fields: [{ page: 1, coord: [97, 561.89, 277, 605.89] }] },
      { email: 'landlord@example.com', fields: [{ page: 1, coord: [97, 663.89, 277, 707.89] }] },
    ]);
  });

  it('簽署區預設落點與改名前相同', () => {
    const rect = (signer: 'party_a' | 'party_b', page: number) =>
      defaultFieldRect({ signer, page, signaturePage: 1, existing: [] as SignatureField[] });

    expect(rect('party_a', 1)).toEqual({
      x: 0.162948528423599,
      y: 0.15916568672867001,
      w: 0.3023787125386373,
      h: 0.052263359821354334,
    });
    expect(rect('party_b', 1)).toEqual({
      x: 0.162948528423599,
      y: 0.2803216572236278,
      w: 0.3023787125386373,
      h: 0.052263359821354334,
    });
    expect(rect('party_a', 0)).toEqual({
      x: 0.60354791022712,
      y: 0.8099514188314387,
      w: 0.3023787125386373,
      h: 0.052263359821354334,
    });
    expect(rect('party_b', 0)).toEqual({
      x: 0.60354791022712,
      y: 0.8812196367696492,
      w: 0.3023787125386373,
      h: 0.052263359821354334,
    });
  });
});
