import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createContract, getContract } from './contracts';
import { convertSignatureFieldsJson } from './legacy-signer-roles';
import { withTx } from './pg/database';
import { setupRouteDb, type RouteDb } from './pg/route-test-kit';
import type { OrgTx } from './pg/with-tx';
import { defaultFieldRect } from './signature-layout';
import { prepareContractSigners } from './signing';
import { loadContractRoutingFacts } from './signature-routing/repository';
import { createDottedSignProvider, type DottedSignRequest } from './signing-module/dottedsign-adapter';
import type { ContractFields, SignatureField } from './types';

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

const LEGACY_FIELDS = {
  landlordName: '林房東',
  landlordEmail: 'landlord@example.com',
  tenantName: '王租客',
  tenantEmail: 'tenant@example.com',
  // 修繕責任也用 landlord、tenant，屬於另一個值域，轉換不得碰
  equipmentAnnex: [{ name: '冷氣', quantity: 1, repair: 'landlord', note: 'tenant 自購' }],
};

// 合約搬到 PostgreSQL 後，舊 SQLite 資料的轉換由搬資料腳本（MIL-90）呼叫 convertSignatureFieldsJson。
describe('既有合約的簽署角色轉換（convertSignatureFieldsJson）', () => {
  const convert = (fields: unknown[]) => {
    const out = convertSignatureFieldsJson(JSON.stringify(fields));
    return out === null ? null : JSON.parse(out);
  };

  it('landlord 改成 party_a、tenant 改成 party_b，頁碼與座標不變', () => {
    expect(convert([LEGACY_LANDLORD_FIELD, LEGACY_TENANT_FIELD])).toEqual([
      { ...LEGACY_LANDLORD_FIELD, signer: 'party_a' },
      { ...LEGACY_TENANT_FIELD, signer: 'party_b' },
    ]);
  });

  it('轉換後再轉一次不改任何東西（回 null）', () => {
    const once = convertSignatureFieldsJson(JSON.stringify([LEGACY_LANDLORD_FIELD, LEGACY_TENANT_FIELD]))!;
    expect(convertSignatureFieldsJson(once)).toBeNull();
  });

  it('新舊值混在同一份合約時，只改舊值', () => {
    const converted = convert([{ ...LEGACY_LANDLORD_FIELD, signer: 'party_a' }, LEGACY_TENANT_FIELD]);
    expect(converted.map((f: SignatureField) => f.signer)).toEqual(['party_a', 'party_b']);
  });

  it('沒有舊值的內容回 null，呼叫端就不寫回', () => {
    expect(convertSignatureFieldsJson('[]')).toBeNull();
    expect(convertSignatureFieldsJson('[ {"id":"p1", "signer":"party_a", "page":0} ]')).toBeNull();
  });

  it('內容不是合法 JSON 陣列時回 null，不丟錯', () => {
    expect(convertSignatureFieldsJson('{not json')).toBeNull();
    expect(convertSignatureFieldsJson('{"signer":"landlord"}')).toBeNull();
  });

  it('修繕責任也用 landlord、tenant，屬於另一個值域，只轉 signer 欄位', () => {
    // 這個函式只收 signature_fields，不會碰合約欄位的 equipmentAnnex.repair
    expect(LEGACY_FIELDS.equipmentAnnex[0].repair).toBe('landlord');
    expect(convert([LEGACY_TENANT_FIELD])).toEqual([{ ...LEGACY_TENANT_FIELD, signer: 'party_b' }]);
  });
});

let kit: RouteDb;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(() => kit.reset());

const inA = <T,>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: kit.orgA }, fn);

describe('轉換後的簽名框位置快照', () => {
  it('送給點點簽的 PDF 座標與轉換前相同', async () => {
    // 舊資料經 convertSignatureFieldsJson 轉換後寫入 PostgreSQL（jsonb）
    const converted = JSON.parse(convertSignatureFieldsJson(JSON.stringify([LEGACY_LANDLORD_FIELD, LEGACY_TENANT_FIELD]))!);
    const id = await inA((tx) =>
      createContract(tx, { property_id: null, fields: LEGACY_FIELDS as unknown as ContractFields, signature_fields: converted }),
    );

    const calls: { body: { stages: { email: string; field_settings: { page: number; coord: number[] }[] }[] } }[] = [];
    const request: DottedSignRequest = async (_path, init) => {
      calls.push({ body: JSON.parse(String(init?.body)) });
      return { data: { task_id: 1 } };
    };
    const routing = await inA((tx) => loadContractRoutingFacts(tx, id));
    if (!routing.ok) throw new Error(routing.reason);
    const prepared = prepareContractSigners((await inA((tx) => getContract(tx, id)))!, routing.facts);
    if (!prepared.ok) throw new Error(prepared.error);
    await createDottedSignProvider({ request, clientSecret: 's' }).createTask({
      subject: { type: 'contract', id },
      document: { fileName: 'a', pdf: new Uint8Array([1]), pageSize: A4 },
      signers: prepared.signers,
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
