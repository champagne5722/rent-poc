import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createContract, getContract } from './contracts';
import { withTx } from './pg/database';
import { setupRouteDb, type RouteDb } from './pg/route-test-kit';
import type { OrgTx } from './pg/with-tx';
import { defaultFieldRect } from './signature-layout';
import { prepareContractSigners } from './signing';
import { loadContractRoutingFacts } from './signature-routing/repository';
import { createDottedSignProvider, type DottedSignRequest } from './signing-module/dottedsign-adapter';
import type { ContractFields, SignatureField } from './types';

// 簽署角色改名後的座標快照（MIL-55、ADR-0010 決議 6）。
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
    equipmentAnnex: [{ name: '冷氣', quantity: 1, repair: 'landlord', note: 'tenant 自購' }],
};

let kit: RouteDb;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(() => kit.reset());

const inA = <T,>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: kit.orgA }, fn);

describe('轉換後的簽名框位置快照', () => {
  it('送給點點簽的 PDF 座標與轉換前相同', async () => {
    const converted = [
      { ...LEGACY_LANDLORD_FIELD, signer: 'party_a' },
      { ...LEGACY_TENANT_FIELD, signer: 'party_b' },
    ] as SignatureField[];
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
