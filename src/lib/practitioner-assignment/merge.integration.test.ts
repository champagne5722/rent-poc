import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContractSubscriber } from '../contract-signing';
import { createContract, getContract, listContractEvents } from '../contracts';
import { createLocalFileStore } from '../file-store/local-file-store';
import { withTx } from '../pg/database';
import { actAs, setupRouteDb, type RouteDb } from '../pg/route-test-kit';
import type { OrgTx } from '../pg/with-tx';
import { createSeedPracticeRegistry, type PracticeRegistryResolution } from '../practice-registry';
import { listSignatureRecords } from '../signature-records/repository';
import { listSigningLapses } from '../signing-lapse/repository';
import type { SigningDb } from '../signing-module/db';
import { createMockProvider } from '../signing-module/mock-adapter';
import { createSigningModule } from '../signing-module/module';
import type { ContractFields, ContractRoutingConditions, SignatureField } from '../types';
import { replaceAssignments } from './repository';
import { loadSendInputs, prepareContractSend } from './send';
import type { PractitionerAssignmentInput } from './seats';

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));

// 整合測試：走簽署模組介面，配 Mock adapter（MIL-76，ADR-0018 決議 9、15）。
// 同一人兼任合併後走到完成，以及居間加包租的四位簽署人走到完成。
// 簽署事件經 webhook 進來，事件時間由參數傳入。
// 資料庫是 PGlite。

const SEND_AT = '2026-11-09T12:00:00+08:00';
const SIGNABLE_AT = '2026-11-10T09:30:00+08:00';
// 陳怡君的證書效期到 2029-05-09，趙經紀到 2028-11-09
const CHEN_LAPSED_AT = '2029-06-01T10:00:00+08:00';
const ZHAO_LAPSED_AT = '2029-01-15T10:00:00+08:00';

const CHEN_EMAIL = 'chen.yijun@beichen.example.com';
const WANG_EMAIL = 'wang.jianguo@beichen.example.com';
const ZHAO_EMAIL = 'zhao.jingji@yunding.example.com';
const TENANT_EMAIL = 'tenant@example.com';

const MANAGER_SLOT = 'lease.master_lease.practitioner';
const BROKER_SLOT = 'lease.broker';

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

beforeEach(async () => {
  await kit.reset();
  actAs(kit.orgA);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-integration-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const inA = <T,>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: kit.orgA }, fn);
const statusOf = async (id: string) => (await inA((tx) => getContract(tx, id)))?.status;
const eventsOf = (id: string) => inA((tx) => listContractEvents(tx, id));
const recordsOf = (id: string) => inA((tx) => listSignatureRecords(tx, id));
const lapsesOf = (id: string) => inA((tx) => listSigningLapses(tx, id));
const signerRow = async (signerId: string) =>
  (await inA((tx) => tx.query<{ position: number; role: string; email: string }>('SELECT position, role, email FROM org.signers WHERE id = $1', [signerId])))
    .rows[0];
const prepareFor = (id: string) =>
  inA(async (tx) => ({ contract: (await getContract(tx, id))!, inputs: await loadSendInputs(tx, id) })).then(({ contract, inputs }) =>
    prepareContractSend(contract, inputs, seed, SEND_AT),
  );

const dbForA = (): SigningDb => ({
  requestOrg: async () => ({ kind: 'org', orgId: kit.orgA }),
  inOrg: (ctx, fn) => withTx(ctx, fn),
  inControl: (fn) => withTx({ kind: 'control' }, fn),
});

const document = {
  fileName: '租賃合約-測試物件',
  pdf: new Uint8Array([37, 80, 68, 70]),
  pageSize: { width: 595.28, height: 841.89 },
};

const sig = (id: string, signer: SignatureField['signer'], slot: string, x: number): SignatureField => ({
  id,
  signer,
  slot,
  page: 1,
  x,
  y: 0.8,
  w: 0.15,
  h: 0.1,
});
const FIELD_B = sig('b', 'party_b', 'lease.master_lease.party_b', 0.05);
const FIELD_P = sig('p', 'practitioner', MANAGER_SLOT, 0.3);
const FIELD_A = sig('a', 'party_a', 'lease.master_lease.party_a', 0.55);
const FIELD_K = sig('k', 'practitioner', BROKER_SLOT, 0.8);

const routing = (brokerMediated: boolean): ContractRoutingConditions => ({
  businessType: 'master_lease',
  lesseeIsMasterLessor: false,
  brokerMediated,
});

const CHEN_AS_LANDLORD = { landlordName: '陳怡君', landlordEmail: CHEN_EMAIL };
const WANG_AS_LANDLORD = { landlordName: '王建國', landlordEmail: WANG_EMAIL };

const managerAssignment = (partySignerId: string): PractitionerAssignmentInput => ({
  slot: MANAGER_SLOT,
  entityId: 'org-pe-beichen',
  practitionerId: 'pr-chen',
  partySignerId,
});
const brokerAssignment: PractitionerAssignmentInput = {
  slot: BROKER_SLOT,
  entityId: 'org-pe-yunding',
  practitionerId: 'pr-zhao',
  partySignerId: null,
};

const unixOf = (iso: string) => Math.floor(Date.parse(iso) / 1000);

async function send(options: {
  landlord: typeof CHEN_AS_LANDLORD;
  brokerMediated: boolean;
  assignments: PractitionerAssignmentInput[];
  fields: SignatureField[];
}) {
  const id = await inA((tx) =>
    createContract(tx, {
      property_id: null,
      fields: {
        routing: routing(options.brokerMediated),
        ...options.landlord,
        tenantName: '王租客',
        tenantEmail: TENANT_EMAIL,
      } as ContractFields,
      signature_fields: options.fields,
    }),
  );
  await inA((tx) => replaceAssignments(tx, id, options.assignments));
  const prepared = await prepareFor(id);
  if (!prepared.ok) throw new Error(prepared.error);
  const signing = createSigningModule({
    provider: createMockProvider(),
    subscribers: { contract: createContractSubscriber({ registry: () => seed }) },
    files: createLocalFileStore(dataDir),
    db: dbForA(),
  });
  const subject = { type: 'contract', id } as const;
  await signing.send(subject, document, prepared.signers, { context: prepared.sendContext });
  const taskRef = (
    await inA((tx) => tx.query<{ ref: string }>('SELECT provider_task_ref AS ref FROM org.sign_tasks WHERE subject_id = $1', [id]))
  ).rows[0].ref;
  const deliver = (action: string, email: string, at: string) =>
    signing.ingestWebhook(
      JSON.stringify({ resource_id: taskRef, resource_type: 'task', action_name: action, event_email: email, event_datetime: unixOf(at) }),
      new Headers(),
    );
  return { id, prepared, signing, subject, deliver };
}

const sendMerged = () =>
  send({ landlord: CHEN_AS_LANDLORD, brokerMediated: false, assignments: [managerAssignment('ps-chen')], fields: [FIELD_B, FIELD_P, FIELD_A] });
const sendFour = () =>
  send({
    landlord: WANG_AS_LANDLORD,
    brokerMediated: true,
    assignments: [managerAssignment('ps-wang'), brokerAssignment],
    fields: [FIELD_B, FIELD_P, FIELD_A, FIELD_K],
  });
const sendMergedWithBroker = () =>
  send({
    landlord: CHEN_AS_LANDLORD,
    brokerMediated: true,
    assignments: [managerAssignment('ps-chen'), brokerAssignment],
    fields: [FIELD_B, FIELD_P, FIELD_A, FIELD_K],
  });

describe('同一人兼任：合併成一位簽署人，簽一次走到完成', () => {
  it('簽署序列少一位：乙方，以及帶兼任角色的執業人員；兩個席位的簽署區域在同一位', async () => {
    const { prepared, signing, subject } = await sendMerged();
    expect(prepared.ok && prepared.signers.map((s) => [s.role, s.email, s.concurrentRoles ?? []])).toEqual([
      ['party_b', TENANT_EMAIL, []],
      ['practitioner', CHEN_EMAIL, ['party_a']],
    ]);
    expect(prepared.signers[1].signatureFields.map((f) => f.id)).toEqual(['p', 'a']);

    const progress = await signing.getProgress(subject);
    expect(progress?.signers.map((s) => [s.role, s.concurrentRoles ?? []])).toEqual([
      ['party_b', []],
      ['practitioner', ['party_a']],
    ]);
  });

  it('乙方簽完輪到合併的簽署人，簽一次後任務完成；重送的簽署事件被忽略，不會當成第二個角色', async () => {
    const { id, subject, signing, deliver } = await sendMerged();
    expect(await statusOf(id)).toBe('awaiting_tenant');

    await deliver('signed', TENANT_EMAIL, '2026-11-10T08:00:00+08:00');
    expect(await statusOf(id)).toBe('awaiting_practitioner');

    await deliver('signed', CHEN_EMAIL, SIGNABLE_AT);
    const retry = await deliver('signed', CHEN_EMAIL, '2026-11-10T09:30:05+08:00');
    expect(retry).toEqual({ status: 200, body: { ok: true, ignored: true } });

    await deliver('completed', 'Server', '2026-11-10T09:31:00+08:00');
    expect(await statusOf(id)).toBe('completed');
    const progress = await signing.getProgress(subject);
    expect(progress?.signers.every((s) => s.status === 'signed')).toBe(true);
    expect((await eventsOf(id)).map((e) => [e.type, e.actor])).toEqual([
      ['created', 'landlord'],
      ['sent', 'landlord'],
      ['signers_merged', 'system'],
      ['signer_signed', 'party_b'],
      ['completed', 'system'],
    ]);
  });

  it('合約歷程記下合併：誰兼任哪兩個角色', async () => {
    const { id } = await sendMerged();
    const merged = (await eventsOf(id)).find((e) => e.type === 'signers_merged');
    expect(merged?.note).toBe('陳怡君同時是甲方的當事人簽署人與執業人員，合併為一位簽署人，簽署一次。');
  });

  it('簽章紀錄一筆，signerIndex 是合併後的位置，標示兼任角色，簽署時補上第二份快照', async () => {
    const { id, deliver } = await sendMerged();
    const [record, ...rest] = await recordsOf(id);
    expect(rest).toEqual([]);
    expect(record).toMatchObject({ ruleId: MANAGER_SLOT, practitionerId: 'pr-chen', concurrentRoles: ['party_a'], snapshotAtSign: null });
    const signer = await signerRow(record.signerId);
    expect(signer).toEqual({ position: 1, role: 'practitioner', email: CHEN_EMAIL });

    await deliver('signed', TENANT_EMAIL, '2026-11-10T08:00:00+08:00');
    await deliver('signed', CHEN_EMAIL, SIGNABLE_AT);
    const [signed] = await recordsOf(id);
    expect(signed.snapshotAtSign).toMatchObject({ decidedAt: new Date(SIGNABLE_AT).toISOString(), result: { signable: true } });
  });

  it('合併的簽署人簽署時已不可簽章，而且是最後一位：合約維持完成，只有一列失效紀錄', async () => {
    const { id, deliver } = await sendMerged();
    await deliver('signed', TENANT_EMAIL, '2026-11-10T08:00:00+08:00');
    await deliver('signed', CHEN_EMAIL, CHEN_LAPSED_AT);
    await deliver('completed', 'Server', '2029-06-01T10:01:00+08:00');

    expect(await statusOf(id)).toBe('completed');
    expect(await lapsesOf(id)).toEqual([
      expect.objectContaining({ ruleId: MANAGER_SLOT, state: 'completed_lapsed', signerName: '陳怡君' }),
    ]);
  });

  it('拒簽：合併的簽署人拒簽，行為者是執業人員', async () => {
    const { id, deliver } = await sendMerged();
    await deliver('signed', TENANT_EMAIL, '2026-11-10T08:00:00+08:00');
    await deliver('declined', CHEN_EMAIL, SIGNABLE_AT);
    expect(await statusOf(id)).toBe('declined');
    expect((await eventsOf(id)).at(-1)).toMatchObject({ type: 'declined', actor: 'practitioner' });
  });
});

describe('居間加包租：四位簽署人依序走到完成', () => {
  it('依序是乙方、專任管理人員、甲方、經紀人；兩位執業人員的簽署區域以席位區分', async () => {
    const { prepared, signing, subject } = await sendFour();
    expect(prepared.ok && prepared.signers.map((s) => [s.role, s.email])).toEqual([
      ['party_b', TENANT_EMAIL],
      ['practitioner', CHEN_EMAIL],
      ['party_a', WANG_EMAIL],
      ['practitioner', ZHAO_EMAIL],
    ]);
    expect(prepared.signers.map((s) => s.signatureFields.map((f) => f.id))).toEqual([['b'], ['p'], ['a'], ['k']]);
    expect((await signing.getProgress(subject))?.signers).toHaveLength(4);
  });

  it('每一位簽完，合約狀態跟著當前簽署人走；兩位執業人員時都是等待執業人員', async () => {
    const { id, deliver } = await sendFour();
    const steps: Array<[string, string]> = [
      [TENANT_EMAIL, 'awaiting_practitioner'],
      [CHEN_EMAIL, 'awaiting_landlord'],
      [WANG_EMAIL, 'awaiting_practitioner'],
    ];
    expect(await statusOf(id)).toBe('awaiting_tenant');
    for (const [email, next] of steps) {
      await deliver('signed', email, SIGNABLE_AT);
      expect(await statusOf(id)).toBe(next);
    }
    await deliver('signed', ZHAO_EMAIL, SIGNABLE_AT);
    await deliver('completed', 'Server', '2026-11-10T10:00:00+08:00');
    expect(await statusOf(id)).toBe('completed');
    // 最後一位簽完等於全員完成，歷程記完成事件，不另記最後一位的簽署
    expect((await eventsOf(id)).filter((e) => e.type === 'signer_signed').map((e) => e.actor)).toEqual([
      'party_b',
      'practitioner',
      'party_a',
    ]);
    // 沒有兼任，不寫合併歷程
    expect((await eventsOf(id)).map((e) => e.type)).not.toContain('signers_merged');
  });

  it('兩筆簽章紀錄的 statute_ref 不同，各自參照自己的簽署人', async () => {
    const { id } = await sendFour();
    const records = await recordsOf(id);
    expect(records.map((r) => [r.ruleId, r.statuteRef, r.practitionerId, r.entityId, r.licenseKind])).toEqual([
      [MANAGER_SLOT, '§32 第 2、3 款', 'pr-chen', 'org-pe-beichen', 'master_lease'],
      [BROKER_SLOT, '經紀條例 §22', 'pr-zhao', 'org-pe-yunding', 'brokerage'],
    ]);
    const signers = (await Promise.all(records.map((r) => signerRow(r.signerId)))).map(({ position, email }) => ({ position, email }));
    expect(signers).toEqual([
      { position: 1, email: CHEN_EMAIL },
      { position: 3, email: ZHAO_EMAIL },
    ]);
    expect(records.every((r) => r.concurrentRoles.length === 0)).toBe(true);
  });

  it('各自簽署時補上第二份快照，證書種類不同', async () => {
    const { id, deliver } = await sendFour();
    for (const email of [TENANT_EMAIL, CHEN_EMAIL, WANG_EMAIL, ZHAO_EMAIL]) await deliver('signed', email, SIGNABLE_AT);
    const records = await recordsOf(id);
    expect(records.map((r) => r.snapshotAtSign && 'certificateKind' in r.snapshotAtSign && r.snapshotAtSign.certificateKind)).toEqual([
      'rental_housing_manager',
      'real_estate_broker',
    ]);
  });

  it('經紀人是最後一位且簽署時已不可簽章：只有經紀人席位一列失效紀錄', async () => {
    const { id, deliver } = await sendFour();
    for (const email of [TENANT_EMAIL, CHEN_EMAIL, WANG_EMAIL]) await deliver('signed', email, '2026-11-10T08:00:00+08:00');
    await deliver('signed', ZHAO_EMAIL, ZHAO_LAPSED_AT);
    await deliver('completed', 'Server', '2029-01-15T10:01:00+08:00');

    expect(await statusOf(id)).toBe('completed');
    expect(await lapsesOf(id)).toEqual([
      expect.objectContaining({ ruleId: BROKER_SLOT, state: 'completed_lapsed', signerName: '趙經紀' }),
    ]);
  });

  it('專任管理人員簽署時已不可簽章、任務未結束：每個席位各記一列，只有失效的那個席位自動撤回', async () => {
    const { id, deliver } = await sendFour();
    await deliver('signed', TENANT_EMAIL, '2026-11-10T08:00:00+08:00');
    await deliver('signed', CHEN_EMAIL, CHEN_LAPSED_AT);

    expect(await statusOf(id)).toBe('voided');
    expect(await lapsesOf(id)).toEqual([expect.objectContaining({ ruleId: MANAGER_SLOT, state: 'voided' })]);
  });
});

describe('兼任合併加經紀人：三位簽署人', () => {
  it('依序是乙方、合併的簽署人、經紀人；簽章紀錄指向合併後的位置', async () => {
    const { id, prepared, deliver } = await sendMergedWithBroker();
    expect(prepared.ok && prepared.signers.map((s) => [s.role, s.concurrentRoles ?? []])).toEqual([
      ['party_b', []],
      ['practitioner', ['party_a']],
      ['practitioner', []],
    ]);
    const records = await recordsOf(id);
    const positions = (await Promise.all(records.map((r) => signerRow(r.signerId)))).map((r) => r.position);
    expect(records.map((r) => r.ruleId)).toEqual([MANAGER_SLOT, BROKER_SLOT]);
    expect(positions).toEqual([1, 2]);
    expect(records.map((r) => r.concurrentRoles)).toEqual([['party_a'], []]);

    for (const email of [TENANT_EMAIL, CHEN_EMAIL, ZHAO_EMAIL]) await deliver('signed', email, SIGNABLE_AT);
    await deliver('completed', 'Server', '2026-11-10T10:00:00+08:00');
    expect(await statusOf(id)).toBe('completed');
  });

  it('經紀營業員不得簽章：送簽前被擋下並說明', async () => {
    const id = await inA((tx) =>
      createContract(tx, {
        property_id: null,
        fields: { routing: routing(true), ...WANG_AS_LANDLORD, tenantName: '王租客', tenantEmail: TENANT_EMAIL } as ContractFields,
        signature_fields: [FIELD_B, FIELD_P, FIELD_A, FIELD_K],
      }),
    );
    await inA((tx) => replaceAssignments(tx, id, [managerAssignment('ps-wang'), { ...brokerAssignment, practitionerId: 'pr-sun' }]));
    const prepared = await prepareFor(id);
    expect(prepared).toMatchObject({ ok: false, status: 400 });
    expect(!prepared.ok && prepared.reasons.map((r) => r.code)).toEqual(['certificate_kind_not_allowed']);
    expect(!prepared.ok && prepared.error).toContain('不動產經紀營業員');
  });
});
