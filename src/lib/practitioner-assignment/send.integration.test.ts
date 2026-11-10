import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLocalFileStore } from '../file-store/local-file-store';
import { createContractSubscriber } from '../contract-signing';
import { createContract, getContract, listContractEvents } from '../contracts';
import { withTx } from '../pg/database';
import { createVerifiedProperty } from '../ownership/test-kit';
import { setupRouteDb, type RouteDb } from '../pg/route-test-kit';
import type { OrgTx } from '../pg/with-tx';
import { createSeedPracticeRegistry, REGISTRY_UNAVAILABLE_REASON, type PracticeRegistryResolution } from '../practice-registry';
import type { ContractFields, ContractRoutingConditions, SignatureField } from '../types';
import { createMockProvider } from '../signing-module/mock-adapter';
import type { SigningDb } from '../signing-module/db';
import { createSigningModule } from '../signing-module/module';
import type { SigningProvider } from '../signing-module/provider';
import { listSignatureRecords } from '../signature-records/repository';
import { replaceAssignments } from './repository';
import { loadSendInputs, prepareContractSend } from './send';

// 整合測試：走簽署模組介面，配 Mock adapter，三位簽署人從送簽走到完成（MIL-69）。
// 資料庫是 PGlite（MIL-85），執業人員資料來自 seed adapter。

const AT = '2026-11-09T12:00:00+08:00';
const seed: PracticeRegistryResolution = {
  available: true,
  registry: createSeedPracticeRegistry({ today: () => '2026-11-09' }),
};

let kit: RouteDb;
let dataDir: string;

beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());

const inA = <T,>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: kit.orgA }, fn);

beforeEach(async () => {
  await kit.reset();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'practitioner-send-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const document = {
  fileName: '租賃合約-測試物件',
  pdf: new Uint8Array([37, 80, 68, 70]),
  pageSize: { width: 595.28, height: 841.89 },
};

const MASTER_LEASE_ROUTING: ContractRoutingConditions = {
  businessType: 'master_lease',
  lesseeIsMasterLessor: false,
  brokerMediated: false,
};
// 包租：甲方是包租業者北辰，由王建國代表。乙方是承租人。
const MASTER_LEASE_FIELDS = {
  routing: MASTER_LEASE_ROUTING,
  landlordName: '王建國',
  landlordEmail: 'wang.jianguo@beichen.example.com',
  tenantName: '王租客',
  tenantEmail: 'tenant@example.com',
};
const MASTER_LEASE_SLOT = 'lease.master_lease.practitioner';
const MASTER_LEASE_FIELDS_ON_PAGE: SignatureField[] = [
  { id: 'b', signer: 'party_b', slot: 'lease.master_lease.party_b', page: 1, x: 0.1, y: 0.8, w: 0.2, h: 0.1 },
  { id: 'p', signer: 'practitioner', slot: MASTER_LEASE_SLOT, page: 1, x: 0.4, y: 0.8, w: 0.2, h: 0.1 },
  { id: 'a', signer: 'party_a', slot: 'lease.master_lease.party_a', page: 1, x: 0.6, y: 0.8, w: 0.2, h: 0.1 },
];

// 自管且承租人是包租業者：乙方是北辰，由王建國代表。甲方是屋主。
const REVERSED_ROUTING: ContractRoutingConditions = {
  businessType: 'self_managed',
  lesseeIsMasterLessor: true,
  brokerMediated: false,
};
const REVERSED_SLOT = 'lease.self_managed_lessee_master_lessor.practitioner';

async function newContract(fields: object, signatureFields: SignatureField[]): Promise<string> {
  const propertyId = await createVerifiedProperty(kit);
  return inA((tx) =>
    createContract(tx, { property_id: propertyId, fields: fields as ContractFields, signature_fields: signatureFields }),
  );
}

const statusOf = async (id: string) => (await inA((tx) => getContract(tx, id)))?.status;
const eventsOf = (id: string) => inA((tx) => listContractEvents(tx, id));
const assign = (id: string, list: Parameters<typeof replaceAssignments>[2]) => inA((tx) => replaceAssignments(tx, id, list));
const recordsOf = (id: string) => inA((tx) => listSignatureRecords(tx, id));

function moduleWith(provider: SigningProvider = createMockProvider()) {
  const db: SigningDb = {
    requestOrg: async () => ({ kind: 'org', orgId: kit.orgA }),
    inOrg: (ctx, fn) => withTx(ctx, fn),
    inControl: (fn) => withTx({ kind: 'control' }, fn),
  };
  return createSigningModule({ provider, subscribers: { contract: createContractSubscriber() }, files: createLocalFileStore(dataDir), db });
}

async function prepare(id: string, resolution = seed) {
  const { contract, inputs } = await inA(async (tx) => ({
    contract: (await getContract(tx, id))!,
    inputs: await loadSendInputs(tx, id),
  }));
  return prepareContractSend(contract, inputs, resolution, AT);
}

const ASSIGN_CHEN = (slot: string) => ({ slot, entityId: 'org-pe-beichen', practitionerId: 'pr-chen', partySignerId: 'ps-wang' });

describe('包租租賃合約：乙方、執業人員、甲方三位走到完成', () => {
  async function sendMasterLease(provider?: SigningProvider) {
    const id = await newContract(MASTER_LEASE_FIELDS, MASTER_LEASE_FIELDS_ON_PAGE);
    await assign(id, [ASSIGN_CHEN(MASTER_LEASE_SLOT)]);
    const prepared = await prepare(id);
    if (!prepared.ok) throw new Error(prepared.error);
    const signing = moduleWith(provider);
    const subject = { type: 'contract', id } as const;
    await signing.send(subject, document, prepared.signers, { context: prepared.sendContext });
    return { id, subject, signing, prepared };
  }

  it('簽署人依序是乙方、執業人員、甲方，執業人員的 email 取自登錄帳號', async () => {
    const { subject, signing, prepared } = await sendMasterLease();
    expect(prepared.ok && prepared.signers.map((s) => [s.role, s.name, s.email])).toEqual([
      ['party_b', '王租客', 'tenant@example.com'],
      ['practitioner', '陳怡君', 'chen.yijun@beichen.example.com'],
      ['party_a', '王建國', 'wang.jianguo@beichen.example.com'],
    ]);
    const progress = await signing.getProgress(subject);
    expect(progress?.signers.map((s) => s.role)).toEqual(['party_b', 'practitioner', 'party_a']);
    expect(progress?.currentSigner).toMatchObject({ role: 'party_b' });
  });

  it('每一位簽完，合約狀態跟著當前簽署人走，三位簽完合約完成', async () => {
    const { id, subject, signing } = await sendMasterLease();
    expect((await statusOf(id))).toBe('awaiting_tenant');

    await signing.simulateEvent(subject, 'signed');
    expect((await statusOf(id))).toBe('awaiting_practitioner');
    expect((await signing.getProgress(subject))?.currentSigner).toMatchObject({
      role: 'practitioner',
      name: '陳怡君',
      email: 'chen.yijun@beichen.example.com',
    });

    await signing.simulateEvent(subject, 'signed');
    expect((await statusOf(id))).toBe('awaiting_landlord');

    await signing.simulateEvent(subject, 'completed');
    expect((await statusOf(id))).toBe('completed');

    expect((await eventsOf(id)).map((e) => [e.type, e.actor])).toEqual([
      ['created', 'landlord'],
      ['sent', 'landlord'],
      ['signer_signed', 'party_b'],
      ['signer_signed', 'practitioner'],
      ['completed', 'system'],
    ]);
    const done = await signing.getProgress(subject);
    expect(done?.signers.every((s) => s.status === 'signed')).toBe(true);
  });

  it('簽署區域依席位分給三位簽署人', async () => {
    const { prepared } = await sendMasterLease();
    if (!prepared.ok) throw new Error();
    expect(prepared.signers.map((s) => s.signatureFields.map((f) => f.id))).toEqual([['b'], ['p'], ['a']]);
  });

  it('送簽前只算出簽章紀錄的資料，建立簽署任務之後才保存', async () => {
    const id = await newContract(MASTER_LEASE_FIELDS, MASTER_LEASE_FIELDS_ON_PAGE);
    await assign(id, [ASSIGN_CHEN(MASTER_LEASE_SLOT)]);
    const prepared = await prepare(id);
    expect(prepared.ok && prepared.sendContext?.records).toHaveLength(1);
    expect(await recordsOf(id)).toEqual([]);
  });

  it('送簽時留下簽章紀錄與當時的證書快照', async () => {
    const { id } = await sendMasterLease();
    const [record] = await recordsOf(id);
    expect(record).toMatchObject({
      ruleId: MASTER_LEASE_SLOT,
      practitionerId: 'pr-chen',
      snapshotAtSend: { decidedAt: AT, result: { signable: true, renewalWindow: null } },
    });
  });

  it('待執業人員簽章時可取簽署連結、重寄與撤回（服務商支援這些操作時）', async () => {
    const mock = createMockProvider();
    const provider: SigningProvider = {
      ...mock,
      unsupported: {},
      getSignLink: async (_ref, email) => `https://sign.example/${email}`,
      resend: async () => {},
    };
    const { id, subject, signing } = await sendMasterLease(provider);
    await signing.simulateEvent(subject, 'signed');
    expect((await statusOf(id))).toBe('awaiting_practitioner');

    const link = await signing.getSignLink(subject, 'https://app.example/contracts/1');
    expect(link.signer).toMatchObject({ role: 'practitioner', email: 'chen.yijun@beichen.example.com' });
    expect(link.url).toBe('https://sign.example/chen.yijun@beichen.example.com');

    expect((await signing.resend(subject)).signer.role).toBe('practitioner');

    await signing.voidTask(subject);
    expect((await statusOf(id))).toBe('voided');
  });

  it('執業人員拒簽：合約已拒簽，行為者是執業人員', async () => {
    const { id, subject, signing } = await sendMasterLease();
    await signing.simulateEvent(subject, 'signed');
    await signing.simulateEvent(subject, 'declined', '證書資料有誤');
    expect((await statusOf(id))).toBe('declined');
    expect((await eventsOf(id)).at(-1)).toMatchObject({ type: 'declined', actor: 'practitioner', note: '證書資料有誤' });
  });
});

describe('自管且承租人是包租業者：甲方、執業人員、乙方', () => {
  it('序列顛倒，三位走到完成', async () => {
    const id = await newContract(
      {
        routing: REVERSED_ROUTING,
        landlordName: '林屋主',
        landlordEmail: 'owner@example.com',
        tenantName: '王建國',
        tenantEmail: 'wang.jianguo@beichen.example.com',
      },
      [
        { id: 'a', signer: 'party_a', page: 1, x: 0.1, y: 0.8, w: 0.2, h: 0.1 },
        { id: 'p', signer: 'practitioner', page: 1, x: 0.4, y: 0.8, w: 0.2, h: 0.1 },
        { id: 'b', signer: 'party_b', page: 1, x: 0.6, y: 0.8, w: 0.2, h: 0.1 },
      ],
    );
    await assign(id, [ASSIGN_CHEN(REVERSED_SLOT)]);
    const prepared = await prepare(id);
    if (!prepared.ok) throw new Error(prepared.error);
    expect(prepared.signers.map((s) => s.role)).toEqual(['party_a', 'practitioner', 'party_b']);

    const signing = moduleWith();
    const subject = { type: 'contract', id } as const;
    await signing.send(subject, document, prepared.signers);
    expect((await statusOf(id))).toBe('awaiting_landlord');
    await signing.simulateEvent(subject, 'signed');
    expect((await statusOf(id))).toBe('awaiting_practitioner');
    await signing.simulateEvent(subject, 'signed');
    expect((await statusOf(id))).toBe('awaiting_tenant');
    await signing.simulateEvent(subject, 'completed');
    expect((await statusOf(id))).toBe('completed');
  });
});

describe('擋下送簽', () => {
  it('缺少執業人員：被擋下，不建立簽署任務（P0-10 AC2）', async () => {
    const id = await newContract(MASTER_LEASE_FIELDS, MASTER_LEASE_FIELDS_ON_PAGE);
    const prepared = await prepare(id);
    expect(prepared).toMatchObject({ ok: false, status: 400 });
    if (prepared.ok) return;
    expect(prepared.reasons.map((r) => r.code)).toContain('practitioner_not_assigned');
    expect(await moduleWith().getProgress({ type: 'contract', id })).toBeNull();
    expect(await recordsOf(id)).toEqual([]);
  });

  it('候選人專任旗標為否：被擋下，原因說明', async () => {
    const id = await newContract(MASTER_LEASE_FIELDS, MASTER_LEASE_FIELDS_ON_PAGE);
    await assign(id, [{ ...ASSIGN_CHEN(MASTER_LEASE_SLOT), practitionerId: 'pr-wu' }]);
    const prepared = await prepare(id);
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.error).toContain('吳家豪不是專任');
  });

  it('多項不符一次列完', async () => {
    const id = await newContract({ ...MASTER_LEASE_FIELDS, landlordEmail: 'someone@example.com' }, MASTER_LEASE_FIELDS_ON_PAGE);
    await assign(id, [{ ...ASSIGN_CHEN(MASTER_LEASE_SLOT), practitionerId: 'pr-zhou' }]);
    const prepared = await prepare(id);
    if (prepared.ok) throw new Error('應被擋下');
    expect(prepared.reasons.map((r) => r.code)).toEqual(['credential_not_signable', 'party_signer_mismatch']);
  });

  it('換證窗口內仍得送簽，並帶換證期限', async () => {
    const id = await newContract(MASTER_LEASE_FIELDS, MASTER_LEASE_FIELDS_ON_PAGE);
    await assign(id, [{ ...ASSIGN_CHEN(MASTER_LEASE_SLOT), practitionerId: 'pr-lin' }]);
    const prepared = await prepare(id);
    expect(prepared.ok && prepared.notices).toEqual([expect.objectContaining({ code: 'renewal_window', validUntil: '2027-02-09' })]);
  });

  it('正式金鑰下沒有真實 adapter：包租合約被擋下（ADR-0021）', async () => {
    const id = await newContract(MASTER_LEASE_FIELDS, MASTER_LEASE_FIELDS_ON_PAGE);
    await assign(id, [ASSIGN_CHEN(MASTER_LEASE_SLOT)]);
    const prepared = await prepare(id, { available: false, reason: REGISTRY_UNAVAILABLE_REASON });
    expect(prepared).toMatchObject({ ok: false });
    if (!prepared.ok) expect(prepared.reasons.map((r) => r.code)).toEqual(['registry_unavailable']);
  });

  it('代管的租賃合約不產生執業人員（P0-12 AC2），正式金鑰下也能送簽', async () => {
    const id = await newContract(
      {
        routing: { businessType: 'managed', lesseeIsMasterLessor: false, brokerMediated: false },
        landlordName: '林屋主',
        landlordEmail: 'owner@example.com',
        tenantName: '王租客',
        tenantEmail: 'tenant@example.com',
      },
      [
        { id: 'a', signer: 'party_a', page: 1, x: 0.1, y: 0.8, w: 0.2, h: 0.1 },
        { id: 'b', signer: 'party_b', page: 1, x: 0.6, y: 0.8, w: 0.2, h: 0.1 },
      ],
    );
    const prepared = await prepare(id, { available: false, reason: REGISTRY_UNAVAILABLE_REASON });
    expect(prepared.ok && prepared.signers.map((s) => s.role)).toEqual(['party_b', 'party_a']);
    expect(prepared.ok && Object.keys(prepared.printed)).toEqual([]);
  });

  it('自管租賃合約的送簽與改動前相同，不需要指派', async () => {
    const id = await newContract(
      { landlordName: '林屋主', landlordEmail: 'owner@example.com', tenantName: '王租客', tenantEmail: 'tenant@example.com' },
      [
        { id: 'a', signer: 'party_a', page: 1, x: 0.1, y: 0.8, w: 0.2, h: 0.1 },
        { id: 'b', signer: 'party_b', page: 1, x: 0.6, y: 0.8, w: 0.2, h: 0.1 },
      ],
    );
    const prepared = await prepare(id);
    expect(prepared.ok && prepared.signers.map((s) => s.role)).toEqual(['party_b', 'party_a']);
  });
});
