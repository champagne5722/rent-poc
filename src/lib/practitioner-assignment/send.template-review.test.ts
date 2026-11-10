import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindTemplate } from '../clause-library';
import { createContract, getContract } from '../contracts';
import { withTx } from '../pg/database';
import { createVerifiedProperty } from '../ownership/test-kit';
import { createVerifiedProperty } from '../ownership/test-kit';
import { setupRouteDb, type RouteDb } from '../pg/route-test-kit';
import type { OrgTx } from '../pg/with-tx';
import { createSeedPracticeRegistry, type PracticeRegistryResolution } from '../practice-registry';
import type { ContractFields, SignatureField } from '../types';
import { loadSendInputs, prepareContractSend } from './send';

// 未審閱範本的送簽閘門（MIL-73、P0-10 AC5）：走 prepareContractSend，原因與其他送簽前檢查一起列出。
// 正式環境以 DOTTEDSIGN_VERIFY_SIGNERS=1 判定。資料庫是 PGlite（MIL-85）。

const AT = '2026-11-09T12:00:00+08:00';
const seed: PracticeRegistryResolution = {
  available: true,
  registry: createSeedPracticeRegistry({ today: () => '2026-11-09' }),
};
const NOT_REVIEWED = '住宅租賃契約 v2 尚未經法務審閱，正式環境無法用它送簽';

let kit: RouteDb;

beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());

const inA = <T,>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: kit.orgA }, fn);

beforeEach(() => kit.reset());

afterEach(() => {
  vi.unstubAllEnvs();
});

const SELF_MANAGED_FIELDS_ON_PAGE: SignatureField[] = [
  { id: 'b', signer: 'party_b', slot: 'lease.self_managed.party_b', page: 1, x: 0.1, y: 0.8, w: 0.2, h: 0.1 },
  { id: 'a', signer: 'party_a', slot: 'lease.self_managed.party_a', page: 1, x: 0.6, y: 0.8, w: 0.2, h: 0.1 },
];

async function newContract(fields: object, signatureFields: SignatureField[] = SELF_MANAGED_FIELDS_ON_PAGE): Promise<string> {
  const propertyId = await createVerifiedProperty(kit);
  return inA((tx) =>
    createContract(tx, {
      property_id: propertyId,
      fields: {
        landlordName: '王大明',
        landlordEmail: 'landlord@example.com',
        tenantName: '李小華',
        tenantEmail: 'tenant@example.com',
        ...bindTemplate(),
        ...fields,
      } as ContractFields,
      signature_fields: signatureFields,
    }),
  );
}

async function prepare(id: string, resolution: PracticeRegistryResolution = seed) {
  const { contract, inputs } = await inA(async (tx) => ({
    contract: (await getContract(tx, id))!,
    inputs: await loadSendInputs(tx, id),
  }));
  return prepareContractSend(contract, inputs, resolution, AT);
}

describe('Mock 與 sandbox 不受限', () => {
  it('沒設 DOTTEDSIGN_VERIFY_SIGNERS：未審閱範本的自管租賃合約可以送簽', async () => {
    const prepared = await prepare(await newContract({}));
    expect(prepared.ok).toBe(true);
  });
});

describe('正式金鑰（DOTTEDSIGN_VERIFY_SIGNERS=1）', () => {
  beforeEach(() => vi.stubEnv('DOTTEDSIGN_VERIFY_SIGNERS', '1'));

  it('未審閱範本的送簽被擋下，並說明原因', async () => {
    const prepared = await prepare(await newContract({}));
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.status).toBe(400);
    expect(prepared.reasons).toEqual([{ code: 'template_not_reviewed', message: NOT_REVIEWED }]);
    expect(prepared.error).toBe(`無法送簽：${NOT_REVIEWED}`);
  });

  it('沒綁範本版本的早期草稿一樣被擋下', async () => {
    const propertyId = await createVerifiedProperty(kit);
    const id = await inA((tx) =>
      createContract(tx, {
        property_id: propertyId,
        fields: {
          landlordName: '王大明',
          landlordEmail: 'landlord@example.com',
          tenantName: '李小華',
          tenantEmail: 'tenant@example.com',
        } as ContractFields,
        signature_fields: SELF_MANAGED_FIELDS_ON_PAGE,
      }),
    );
    const prepared = await prepare(id);
    expect(!prepared.ok && prepared.reasons.map((r) => r.code)).toEqual(['template_not_reviewed']);
  });

  it('與其他送簽前原因一起列出：包租合約還沒指派執業人員', async () => {
    const id = await newContract({
      routing: { businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: false },
    });
    const prepared = await prepare(id);
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.reasons.map((r) => r.code)).toEqual(['practitioner_not_assigned', 'template_not_reviewed']);
    expect(prepared.error).toContain(NOT_REVIEWED);
    expect(prepared.error).toContain('尚未指派');
  });

  it('登錄資料來源不可用時，兩個原因都列出', async () => {
    const id = await newContract({
      routing: { businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: false },
    });
    const prepared = await prepare(id, { available: false, reason: '登錄資料來源不可用' });
    expect(!prepared.ok && prepared.reasons.map((r) => r.code)).toContain('registry_unavailable');
    expect(!prepared.ok && prepared.reasons.map((r) => r.code)).toContain('template_not_reviewed');
  });
});
