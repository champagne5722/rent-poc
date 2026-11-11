import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as copyRoute } from '../../app/api/contracts/[id]/copy/route';
import { POST as voidRoute } from '../../app/api/contracts/[id]/void/route';
import { attachContract, createLeaseCase, getCase, listCaseEvents } from '../case-store';
import { createContractSubscriber } from '../contract-signing';
import { createContract, getContract, getContractRelations, listContractEvents } from '../contracts';
import { createLocalFileStore } from '../file-store/local-file-store';
import { withTx } from '../pg/database';
import { createVerifiedProperty } from '../ownership/test-kit';
import { shortUlid } from '../pg/ulid';
import { actAs, setupRouteDb, TEST_PARTY_ID, type RouteDb } from '../pg/route-test-kit';
import type { OrgTx } from '../pg/with-tx';
import { getProperty } from '../properties';
import { createSeedPracticeRegistry, type PracticeRegistryResolution } from '../practice-registry';
import { replaceAssignments, type CaseSeatMember } from '../practitioner-assignment/repository';
import { newUlid } from '../pg/ulid';
import { loadSendInputs, prepareContractSend } from '../practitioner-assignment/send';
import { listSignatureRecords } from '../signature-records/repository';
import type { SigningDb } from '../signing-module/db';
import { createMockProvider } from '../signing-module/mock-adapter';
import { createSigningModule } from '../signing-module/module';
import type { SigningProvider } from '../signing-module/provider';
import type { ContractFields, ContractRoutingConditions, SignatureField } from '../types';
import { listSigningLapses } from './repository';

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));

// 整合測試：走簽署模組介面，配 Mock adapter（MIL-75，ADR-0018 決議 11 情況 B）。
// 三位簽署人：乙方、執業人員、甲方。事件時間晚於證書效期，就是執業人員簽署當下已不可簽章。
// 所有時間都由參數傳入，不依賴系統時鐘。
// 資料庫是 PGlite。

const SEND_AT = '2026-11-09T12:00:00+08:00';
const SEED_TODAY = '2026-11-09';
const LAPSED_AT = '2029-06-01T10:00:00+08:00';
const SIGNABLE_AT = '2026-11-10T09:30:00+08:00';
const SLOT = 'lease.master_lease.practitioner';
const PRACTITIONER_EMAIL = 'chen.yijun@beichen.example.com';
const LANDLORD_EMAIL = 'wang.jianguo@beichen.example.com';
const TENANT_EMAIL = 'tenant@example.com';

const seed: PracticeRegistryResolution = {
  available: true,
  registry: createSeedPracticeRegistry({ today: () => SEED_TODAY }),
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signing-lapse-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const inA = <T,>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: kit.orgA }, fn);
const statusOf = async (id: string) => (await inA((tx) => getContract(tx, id)))?.status;

// withTx 不得巢狀：呼叫當下如果還開著交易，再開一個會丟錯。能開成功，就代表呼叫當下沒有任何交易。
const insideTransaction = () =>
  inA(async () => false).catch((e: unknown) => {
    if (e instanceof Error && e.message.includes('不得巢狀')) return true;
    throw e;
  });

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

const ROUTING: ContractRoutingConditions = { businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: false };
const FIELDS = {
  routing: ROUTING,
  landlordName: '王建國',
  landlordEmail: LANDLORD_EMAIL,
  tenantName: '王租客',
  tenantEmail: TENANT_EMAIL,
};
const SIGNATURE_FIELDS: SignatureField[] = [
  { id: 'b', signer: 'party_b', slot: 'lease.master_lease.party_b', page: 1, x: 0.1, y: 0.8, w: 0.2, h: 0.1 },
  { id: 'p', signer: 'practitioner', slot: SLOT, page: 1, x: 0.4, y: 0.8, w: 0.2, h: 0.1 },
  { id: 'a', signer: 'party_a', slot: 'lease.master_lease.party_a', page: 1, x: 0.6, y: 0.8, w: 0.2, h: 0.1 },
];

const unixOf = (iso: string) => Math.floor(Date.parse(iso) / 1000);

// 包住 Mock adapter 的 voidTask：記錄呼叫、記錄呼叫當下是否在交易內，可以指定失敗
function spiedProvider() {
  const mock = createMockProvider();
  const state = { calls: 0, inTransaction: [] as boolean[], failWith: null as string | null };
  const provider: SigningProvider = {
    ...mock,
    voidTask: async (taskRef) => {
      state.calls += 1;
      state.inTransaction.push(await insideTransaction());
      if (state.failWith) throw new Error(state.failWith);
      return mock.voidTask(taskRef);
    },
  };
  return { provider, state };
}

// practitionerLast：測試用，把簽署序列改成乙方、甲方、執業人員，讓執業人員是最後一位
// withCase：合約掛在屋主組織的自管租賃案件下（MIL-115），驗證自動撤回時案件跟著回 draft
async function setup(registry: PracticeRegistryResolution = seed, { practitionerLast = false, withCase = false } = {}) {
  let caseId: string | null = null;
  // 送簽要求物件已通過文件核對（MIL-205），有沒有案件都一樣
  const propertyId = await createVerifiedProperty(kit, { name: '案件測試物件' });
  if (withCase) {
    caseId = await inA(async (tx) =>
      createLeaseCase(tx, {
        orgId: kit.orgA,
        orgKind: 'owner',
        businessType: 'self_managed',
        lessorPartyId: TEST_PARTY_ID,
        property: (await getProperty(tx, propertyId))!,
      }),
    );
  }
  // 分流事實取自案件（MIL-200）：這份合約的快照是包租轉租（master_lease），案件的種類要一致
  if (caseId) {
    await inA((tx) => tx.query(`UPDATE org.cases SET business_type = 'master_lease', case_kind = 'sublease' WHERE id = $1`, [caseId]));
  }
  const id = await inA((tx) =>
    createContract(tx, {
      property_id: propertyId,
      fields: FIELDS as ContractFields,
      signature_fields: SIGNATURE_FIELDS,
      case_id: caseId,
    }),
  );
  if (caseId) await inA((tx) => attachContract(tx, caseId!, id));
  // 合約掛在案件下時，指派存成案件成員（MIL-200），要帶執業人員的 party。seed 的 partyId 不是 ULID，換成真實的
  const seats: CaseSeatMember[] = [];
  if (caseId) {
    const partyId = newUlid();
    await kit.asOwner((db) =>
      db.query('INSERT INTO control.parties (id, email, display_name) VALUES ($1, $2, $3)', [partyId, `${partyId.toLowerCase()}@seed.test`, '陳怡君']),
    );
    seats.push({ slot: SLOT, partyId, relation: 'practitioner' });
  }
  await inA((tx) =>
    replaceAssignments(tx, id, [{ slot: SLOT, entityId: 'org-pe-beichen', practitionerId: 'pr-chen', partySignerId: 'ps-wang' }], seats),
  );
  const prepared = await inA(async (tx) => ({ contract: (await getContract(tx, id))!, inputs: await loadSendInputs(tx, id) })).then(
    ({ contract, inputs }) => prepareContractSend(contract, inputs, seed, SEND_AT),
  );
  if (!prepared.ok) throw new Error(prepared.error);
  const { provider, state } = spiedProvider();
  const signing = createSigningModule({
    provider,
    subscribers: { contract: createContractSubscriber({ registry: () => registry }) },
    files: createLocalFileStore(dataDir),
    db: dbForA(),
  });
  const subject = { type: 'contract', id } as const;
  const taskRef = async () =>
    (await inA((tx) => tx.query<{ ref: string }>('SELECT provider_task_ref AS ref FROM org.sign_tasks WHERE subject_id = $1', [id])))
      .rows[0].ref;
  const deliver = async (action: string, email: string, at: string) =>
    signing.ingestWebhook(
      JSON.stringify({ resource_id: await taskRef(), resource_type: 'task', action_name: action, event_email: email, event_datetime: unixOf(at) }),
      new Headers(),
    );
  if (practitionerLast) {
    const [b, p, a] = prepared.signers;
    const records = prepared.sendContext!.records.map((r) => ({ ...r, signerIndex: 2 }));
    await signing.send(subject, document, [b, a, p], { context: { ...prepared.sendContext!, records } });
  } else {
    await signing.send(subject, document, prepared.signers, { context: prepared.sendContext });
  }
  return { id, caseId, signing, subject, deliver, voidSpy: state };
}

const eventsOf = (id: string) => inA((tx) => listContractEvents(tx, id));
const eventTypes = async (id: string) => (await eventsOf(id)).map((e) => e.type);
const countOf = async (sql: string, param: string) => (await inA((tx) => tx.query<{ n: number }>(sql, [param]))).rows[0].n;
const lapsesOf = (id: string) => inA((tx) => listSigningLapses(tx, id));

describe('任務未結束：簽署進度照常推進，交易提交後自動撤回', () => {
  it('執業人員簽署時已不可簽章：進度與快照照寫，之後合約被自動撤回，歷程記下原因', async () => {
    const { id, signing, subject, deliver, voidSpy } = await setup();
    await deliver('signed', TENANT_EMAIL, '2026-11-10T08:00:00+08:00');
    const ack = await deliver('signed', PRACTITIONER_EMAIL, LAPSED_AT);

    expect(ack).toEqual({ status: 200, body: { ok: true } });
    expect(await statusOf(id)).toBe('voided');
    // 簽署進度照常推進：兩位已簽
    const progress = await signing.getProgress(subject);
    expect(progress?.status).toBe('voided');
    expect(progress?.signers.map((s) => s.status)).toEqual(['signed', 'signed', 'pending']);
    // 簽署當下的判定寫進快照
    const [record] = await inA((tx) => listSignatureRecords(tx, id));
    expect(record.snapshotAtSign).toMatchObject({ result: { signable: false } });
    // 自動撤回只呼叫一次，而且不在交易內
    expect(voidSpy.calls).toBe(1);
    expect(voidSpy.inTransaction).toEqual([false]);
    // 失效事實與撤回都在歷程
    const events = await eventsOf(id);
    expect(events.map((e) => e.type)).toEqual(['created', 'sent', 'signer_signed', 'signer_signed', 'credential_lapsed', 'voided']);
    expect(events.find((e) => e.type === 'credential_lapsed')).toMatchObject({ actor: 'system', note: expect.stringContaining('陳怡君') });
    expect(events.find((e) => e.type === 'voided')).toMatchObject({ actor: 'system', note: expect.stringContaining('自動撤回') });
    // 失效紀錄
    expect(await lapsesOf(id)).toEqual([
      expect.objectContaining({ ruleId: SLOT, state: 'voided', signerName: '陳怡君', voidError: null }),
    ]);
  });

  it('合約有案件：自動撤回後案件收到撤回事件，signing 回到 draft，目前合約不變（MIL-115）', async () => {
    const { id, caseId, deliver } = await setup(seed, { withCase: true });
    const readCase = () => inA(async (tx) => ({ record: await getCase(tx, caseId!), events: await listCaseEvents(tx, caseId!) }));
    expect((await readCase()).record?.state).toBe('signing');

    await deliver('signed', TENANT_EMAIL, '2026-11-10T08:00:00+08:00');
    expect((await readCase()).record?.state).toBe('signing'); // 簽到一半不動案件
    await deliver('signed', PRACTITIONER_EMAIL, LAPSED_AT);

    expect(await statusOf(id)).toBe('voided');
    const { record, events } = await readCase();
    expect(record).toMatchObject({ state: 'draft', currentContractId: id });
    expect(events.at(-1)).toMatchObject({ type: 'contract_voided', fromState: 'signing', toState: 'draft' });
    // 重複的簽署事件不會再推進案件
    await deliver('signed', PRACTITIONER_EMAIL, '2029-06-01T10:00:05+08:00');
    expect((await readCase()).events.filter((e) => e.type === 'contract_voided')).toHaveLength(1);
  });

  it('合約有案件：自動撤回失敗時案件維持 signing，手動撤回後才回 draft', async () => {
    const { id, caseId, deliver, voidSpy } = await setup(seed, { withCase: true });
    voidSpy.failWith = '點點簽暫時無法連線';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await deliver('signed', TENANT_EMAIL, '2026-11-10T08:00:00+08:00');
    await deliver('signed', PRACTITIONER_EMAIL, LAPSED_AT);
    expect((await inA((tx) => getCase(tx, caseId!)))?.state).toBe('signing');

    voidSpy.failWith = null;
    const res = await voidRoute(new Request('http://localhost/x') as never, { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    expect((await inA((tx) => getCase(tx, caseId!)))?.state).toBe('draft');
  });

  it('重複的簽署事件不會重複撤回', async () => {
    const { id, deliver, voidSpy } = await setup();
    await deliver('signed', TENANT_EMAIL, '2026-11-10T08:00:00+08:00');
    await deliver('signed', PRACTITIONER_EMAIL, LAPSED_AT);
    const retry = await deliver('signed', PRACTITIONER_EMAIL, '2029-06-01T10:00:05+08:00');

    expect(retry).toEqual({ status: 200, body: { ok: true, ignored: true } });
    expect(voidSpy.calls).toBe(1);
    expect((await eventTypes(id)).filter((t) => t === 'credential_lapsed')).toHaveLength(1);
    expect((await eventTypes(id)).filter((t) => t === 'voided')).toHaveLength(1);
    expect(await lapsesOf(id)).toHaveLength(1);
  });

  it('簽署當下仍可簽章：不撤回，也不留失效紀錄', async () => {
    const { id, deliver, voidSpy } = await setup();
    await deliver('signed', TENANT_EMAIL, '2026-11-10T08:00:00+08:00');
    await deliver('signed', PRACTITIONER_EMAIL, SIGNABLE_AT);

    expect(await statusOf(id)).toBe('awaiting_landlord');
    expect(voidSpy.calls).toBe(0);
    expect(await lapsesOf(id)).toEqual([]);
    expect(await eventTypes(id)).not.toContain('credential_lapsed');
  });

  it('查不到登錄資料時無法判定：不當作失效，簽署進度照常', async () => {
    const { id, deliver, voidSpy } = await setup({ available: false, reason: '登錄資料來源不可用' });
    await deliver('signed', TENANT_EMAIL, '2026-11-10T08:00:00+08:00');
    await deliver('signed', PRACTITIONER_EMAIL, LAPSED_AT);

    expect(await statusOf(id)).toBe('awaiting_landlord');
    expect(voidSpy.calls).toBe(0);
    expect(await lapsesOf(id)).toEqual([]);
  });

  it('執業人員拒簽：不是簽署，不留失效紀錄', async () => {
    const { id, deliver, voidSpy } = await setup();
    await deliver('signed', TENANT_EMAIL, '2026-11-10T08:00:00+08:00');
    await deliver('declined', PRACTITIONER_EMAIL, LAPSED_AT);

    expect(await statusOf(id)).toBe('declined');
    expect(voidSpy.calls).toBe(0);
    expect(await lapsesOf(id)).toEqual([]);
  });
});

describe('任務已全員完成：合約維持完成，留下事實', () => {
  it('完成事件比執業人員的簽署事件先到，完成時不可簽章：合約維持完成，不撤回', async () => {
    const { id, deliver, voidSpy } = await setup();
    await deliver('signed', TENANT_EMAIL, '2026-11-10T08:00:00+08:00');
    const ack = await deliver('completed', 'Server', LAPSED_AT);

    expect(ack).toEqual({ status: 200, body: { ok: true } });
    expect(await statusOf(id)).toBe('completed');
    expect(voidSpy.calls).toBe(0);
    const events = await eventsOf(id);
    expect(events.map((e) => e.type)).toEqual(['created', 'sent', 'signer_signed', 'completed', 'credential_lapsed']);
    expect(events.find((e) => e.type === 'credential_lapsed')?.note).toContain('維持已完成');
    expect(await lapsesOf(id)).toEqual([
      expect.objectContaining({ ruleId: SLOT, state: 'completed_lapsed', signerName: '陳怡君' }),
    ]);
  });

  it('自動撤回時任務已經結束：撤回失敗，之後全員完成，失效紀錄改記合約已完成', async () => {
    const { id, deliver, voidSpy } = await setup();
    voidSpy.failWith = '任務已結束，無法撤回';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await deliver('signed', TENANT_EMAIL, '2026-11-10T08:00:00+08:00');
    await deliver('signed', PRACTITIONER_EMAIL, LAPSED_AT);
    expect((await lapsesOf(id))[0].state).toBe('void_failed');

    await deliver('signed', LANDLORD_EMAIL, '2029-06-01T10:05:00+08:00');
    await deliver('completed', 'Server', '2029-06-01T10:05:05+08:00');

    expect(await statusOf(id)).toBe('completed');
    expect((await lapsesOf(id))[0]).toMatchObject({ state: 'completed_lapsed' });
  });
});

describe('執業人員是最後一位簽署人', () => {
  it('簽完就是全員簽署：不撤回，記為合約維持完成；完成事件到達後合約完成', async () => {
    const { id, deliver, voidSpy } = await setup(seed, { practitionerLast: true });
    await deliver('signed', TENANT_EMAIL, '2026-11-10T08:00:00+08:00');
    await deliver('signed', LANDLORD_EMAIL, '2026-11-10T08:30:00+08:00');
    const ack = await deliver('signed', PRACTITIONER_EMAIL, LAPSED_AT);
    expect(ack).toEqual({ status: 200, body: { ok: true } });
    expect(voidSpy.calls).toBe(0);
    expect(await lapsesOf(id)).toEqual([expect.objectContaining({ state: 'completed_lapsed' })]);

    await deliver('completed', 'Server', '2029-06-01T10:00:05+08:00');
    expect(await statusOf(id)).toBe('completed');
    expect(voidSpy.calls).toBe(0);
    expect((await eventTypes(id)).filter((t) => t === 'credential_lapsed')).toHaveLength(1);
  });
});

describe('自動撤回失敗：webhook 仍回 2xx，使用者手動撤回', () => {
  it('服務商撤回失敗：回 2xx、合約維持簽署中、記下失敗原因與歷程', async () => {
    const { id, deliver, voidSpy } = await setup();
    voidSpy.failWith = '點點簽暫時無法連線';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await deliver('signed', TENANT_EMAIL, '2026-11-10T08:00:00+08:00');
    const ack = await deliver('signed', PRACTITIONER_EMAIL, LAPSED_AT);

    expect(ack).toEqual({ status: 200, body: { ok: true } });
    expect(await statusOf(id)).toBe('awaiting_landlord');
    expect(await lapsesOf(id)).toEqual([
      expect.objectContaining({ state: 'void_failed', voidError: expect.stringContaining('點點簽暫時無法連線') }),
    ]);
    expect(await eventTypes(id)).toEqual(['created', 'sent', 'signer_signed', 'signer_signed', 'credential_lapsed', 'auto_void_failed']);
  });

  it('失敗後重複的簽署事件不會再試一次自動撤回', async () => {
    const { deliver, voidSpy } = await setup();
    voidSpy.failWith = '點點簽暫時無法連線';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await deliver('signed', TENANT_EMAIL, '2026-11-10T08:00:00+08:00');
    await deliver('signed', PRACTITIONER_EMAIL, LAPSED_AT);
    await deliver('signed', PRACTITIONER_EMAIL, '2029-06-01T10:00:05+08:00');
    expect(voidSpy.calls).toBe(1);
  });

  it('手動撤回走既有的撤回 route：合約已撤回、失效紀錄改記已撤回、行為者是出租人', async () => {
    const { id, deliver, voidSpy } = await setup();
    voidSpy.failWith = '點點簽暫時無法連線';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await deliver('signed', TENANT_EMAIL, '2026-11-10T08:00:00+08:00');
    await deliver('signed', PRACTITIONER_EMAIL, LAPSED_AT);

    voidSpy.failWith = null;
    const res = await voidRoute(new Request('http://localhost/x') as never, { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    expect(await statusOf(id)).toBe('voided');
    expect((await lapsesOf(id))[0].state).toBe('voided');
    expect((await eventsOf(id)).at(-1)).toMatchObject({ type: 'voided', actor: 'landlord' });
  });

  it('手動撤回也失敗時，失效紀錄維持撤回失敗，使用者能再試', async () => {
    const { id, signing, subject, deliver, voidSpy } = await setup();
    voidSpy.failWith = '點點簽暫時無法連線';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await deliver('signed', TENANT_EMAIL, '2026-11-10T08:00:00+08:00');
    await deliver('signed', PRACTITIONER_EMAIL, LAPSED_AT);
    await expect(signing.voidTask(subject)).rejects.toThrow('點點簽暫時無法連線');
    expect((await lapsesOf(id))[0].state).toBe('void_failed');
    voidSpy.failWith = null;
    await signing.voidTask(subject);
    expect(await statusOf(id)).toBe('voided');
  });
});

describe('撤回後複製為新草稿（ADR-0006）', () => {
  it('自動撤回後複製：新草稿記衍生關聯，沿用執業人員指派，來源記被複製', async () => {
    const { id, deliver } = await setup();
    await deliver('signed', TENANT_EMAIL, '2026-11-10T08:00:00+08:00');
    await deliver('signed', PRACTITIONER_EMAIL, LAPSED_AT);
    expect(await statusOf(id)).toBe('voided');

    const res = await copyRoute(new Request('http://localhost/x') as never, { params: Promise.resolve({ id }) });
    expect(res.status).toBe(201);
    const newId = (await res.json()).data.id as string;

    const copy = (await inA((tx) => getContract(tx, newId)))!;
    expect(copy.status).toBe('draft');
    expect(copy.derived_from).toBe(id);
    const relations = await inA(async (tx) => getContractRelations(tx, (await getContract(tx, id))!));
    expect(relations.derived_contracts).toEqual([{ id: newId, status: 'draft' }]);
    expect((await eventsOf(newId))[0]).toMatchObject({ type: 'created', note: expect.stringContaining(`合約 #${shortUlid(id)}`) });
    expect((await eventTypes(id)).at(-1)).toBe('copied');
    // 新草稿不帶舊的簽署任務與簽章紀錄，全員重簽
    expect(await countOf('SELECT COUNT(*)::int AS n FROM org.sign_tasks WHERE subject_id = $1', newId)).toBe(0);
    expect(await inA((tx) => listSignatureRecords(tx, newId))).toEqual([]);
    expect(await countOf('SELECT COUNT(*)::int AS n FROM org.contract_practitioner_assignments WHERE contract_id = $1', newId)).toBe(1);
  });
});
