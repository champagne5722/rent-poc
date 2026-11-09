import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContractSubscriber } from '../contract-signing';
import { ensureSchema, getContract, insertContractWithEvent, setDb } from '../db';
import { createSeedPracticeRegistry, type PracticeRegistryResolution } from '../practice-registry';
import { replaceAssignments } from '../practitioner-assignment/repository';
import { prepareContractSend, type PreparedContractSend } from '../practitioner-assignment/send';
import { createMockProvider } from '../signing-module/mock-adapter';
import { createSigningModule } from '../signing-module/module';
import type { SigningProvider } from '../signing-module/provider';
import type { SigningSubscriber } from '../signing-module/subscriber';
import type { ContractRoutingConditions, SignatureField } from '../types';
import { GET as getSignatureRecordsRoute } from '../../app/api/contracts/[id]/signature-records/route';
import { listSignatureRecords } from './repository';

// 整合測試：走簽署模組介面，配 Mock adapter（MIL-70）。
// 三位簽署人：乙方、執業人員、甲方。執業人員的簽章紀錄在送簽時寫 snapshot_at_send，簽署事件時補 snapshot_at_sign。

const SEND_AT = '2026-11-09T12:00:00+08:00';
const SEED_TODAY = '2026-11-09';
const SLOT = 'lease.master_lease.practitioner';
const PRACTITIONER_EMAIL = 'chen.yijun@beichen.example.com';

const seed: PracticeRegistryResolution = {
  available: true,
  registry: createSeedPracticeRegistry({ today: () => SEED_TODAY }),
};

let db: Database.Database;
let dataDir: string;

beforeEach(() => {
  db = new Database(':memory:');
  ensureSchema(db);
  setDb(db);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signature-records-'));
});

afterEach(() => {
  setDb(null);
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
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
  landlordEmail: 'wang.jianguo@beichen.example.com',
  tenantName: '王租客',
  tenantEmail: 'tenant@example.com',
};
const SIGNATURE_FIELDS: SignatureField[] = [
  { id: 'b', signer: 'party_b', slot: 'lease.master_lease.party_b', page: 1, x: 0.1, y: 0.8, w: 0.2, h: 0.1 },
  { id: 'p', signer: 'practitioner', slot: SLOT, page: 1, x: 0.4, y: 0.8, w: 0.2, h: 0.1 },
  { id: 'a', signer: 'party_a', slot: 'lease.master_lease.party_a', page: 1, x: 0.6, y: 0.8, w: 0.2, h: 0.1 },
];

const unixOf = (iso: string) => Math.floor(Date.parse(iso) / 1000);

interface Setup {
  registry?: PracticeRegistryResolution;
  provider?: SigningProvider;
  wrapSubscriber?: (inner: SigningSubscriber) => SigningSubscriber;
  now?: () => Date;
}

async function setup({ registry = seed, provider = createMockProvider(), wrapSubscriber, now }: Setup = {}) {
  const id = insertContractWithEvent(
    { property_id: null, fields: JSON.stringify(FIELDS), signature_fields: JSON.stringify(SIGNATURE_FIELDS) },
    { type: 'created', actor: 'landlord' },
    db,
  );
  await replaceAssignments(
    id,
    [{ slot: SLOT, entityId: 'org-pe-beichen', practitionerId: 'pr-chen', partySignerId: 'ps-wang' }],
    db,
  );
  const prepared = await prepareContractSend(getContract(id)!, seed, SEND_AT, db);
  if (!prepared.ok) throw new Error(prepared.error);
  const subscriber = createContractSubscriber({ registry: () => registry });
  const signing = createSigningModule({
    provider,
    subscribers: { contract: wrapSubscriber ? wrapSubscriber(subscriber) : subscriber },
    dataDir,
    now,
  });
  const subject = { type: 'contract', id } as const;
  const send = (p: Extract<PreparedContractSend, { ok: true }> = prepared) =>
    signing.send(subject, document, p.signers, p.sendContext);
  const taskRef = () =>
    (db.prepare('SELECT provider_task_ref AS ref FROM sign_tasks WHERE subject_id = ?').get(String(id)) as { ref: string }).ref;
  const deliver = (action: string, email: string, at: string) =>
    signing.ingestWebhook(
      JSON.stringify({ resource_id: taskRef(), resource_type: 'task', action_name: action, event_email: email, event_datetime: unixOf(at) }),
      new Headers(),
    );
  return { id, prepared, signing, subject, send, deliver };
}

describe('送簽：簽章紀錄與簽署任務同一個交易', () => {
  it('送簽後執業人員有一列簽章紀錄，參照簽署人列，帶 snapshot_at_send', async () => {
    const { id, send } = await setup();
    await send();
    const records = await listSignatureRecords(id, db);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      ruleId: SLOT,
      ruleVersion: expect.any(Number),
      statuteRef: expect.stringContaining('§32'),
      practitionerId: 'pr-chen',
      employmentId: 'emp-pr-chen',
      entityId: 'org-pe-beichen',
      concurrentRoles: [],
      snapshotAtSign: null,
    });
    expect(records[0].snapshotAtSend).toMatchObject({
      decidedAt: SEND_AT,
      certificateKind: 'rental_housing_manager',
      result: { signable: true, renewalWindow: null },
    });
    const signer = db.prepare('SELECT role, email FROM signers WHERE id = ?').get(records[0].signerId);
    expect(signer).toEqual({ role: 'practitioner', email: PRACTITIONER_EMAIL });
  });

  it('簽章紀錄寫入失敗時，簽署任務與合約狀態一起回滾', async () => {
    const { id, prepared, signing, subject } = await setup();
    const broken = { ...prepared.sendContext!, records: prepared.sendContext!.records.map((r) => ({ ...r, signerIndex: 9 })) };
    await expect(signing.send(subject, document, prepared.signers, broken)).rejects.toThrow();
    expect(await signing.getProgress(subject)).toBeNull();
    expect(getContract(id)?.status).toBe('draft');
    expect(await listSignatureRecords(id, db)).toEqual([]);
  });

  it('簽署服務商建立任務失敗時不留簽章紀錄', async () => {
    const mock = createMockProvider();
    const failing: SigningProvider = { ...mock, createTask: async () => { throw new Error('服務商失敗'); } };
    const { id, send } = await setup({ provider: failing });
    await expect(send()).rejects.toThrow('服務商失敗');
    expect(await listSignatureRecords(id, db)).toEqual([]);
  });

  it('兩方合約沒有執業人員，不寫簽章紀錄', async () => {
    const id = insertContractWithEvent(
      {
        property_id: null,
        fields: JSON.stringify({ ...FIELDS, routing: { businessType: 'self_managed', lesseeIsMasterLessor: false, brokerMediated: false } }),
        signature_fields: JSON.stringify([
          { id: 'b', signer: 'party_b', page: 1, x: 0.1, y: 0.8, w: 0.2, h: 0.1 },
          { id: 'a', signer: 'party_a', page: 1, x: 0.6, y: 0.8, w: 0.2, h: 0.1 },
        ]),
      },
      { type: 'created', actor: 'landlord' },
      db,
    );
    const prepared = await prepareContractSend(getContract(id)!, seed, SEND_AT, db);
    if (!prepared.ok) throw new Error(prepared.error);
    expect(prepared.sendContext?.records ?? []).toEqual([]);
    const signing = createSigningModule({ provider: createMockProvider(), subscribers: { contract: createContractSubscriber() }, dataDir });
    await signing.send({ type: 'contract', id }, document, prepared.signers, prepared.sendContext);
    expect(await listSignatureRecords(id, db)).toEqual([]);
  });
});

describe('簽署事件：補 snapshot_at_sign，判定用事件時間', () => {
  it('乙方簽署時不補，執業人員簽署時補，時點是事件時間而不是系統收到的時間', async () => {
    const { id, send, deliver } = await setup();
    await send();
    await deliver('signed', 'tenant@example.com', '2026-11-10T08:00:00+08:00');
    expect((await listSignatureRecords(id, db))[0].snapshotAtSign).toBeNull();

    await deliver('signed', PRACTITIONER_EMAIL, '2026-11-10T09:30:00+08:00');
    const [record] = await listSignatureRecords(id, db);
    expect(record.snapshotAtSign).toMatchObject({
      decidedAt: new Date(unixOf('2026-11-10T09:30:00+08:00') * 1000).toISOString(),
      certificateKind: 'rental_housing_manager',
      result: { signable: true, renewalWindow: null },
    });
    // 送簽時的快照沒有被動到
    expect(record.snapshotAtSend.decidedAt).toBe(SEND_AT);
  });

  it('事件時間晚於證書效期時，快照記下不可簽章；簽署進度照常推進', async () => {
    // 這項只驗 MIL-70 的快照與簽署進度。MIL-75 之後不可簽章會自動撤回，所以這裡關掉撤回（見 signing-lapse 的整合測試）
    const { id, send, deliver, signing, subject } = await setup({
      wrapSubscriber: (inner) => ({ ...inner, afterOutcome: undefined }),
    });
    await send();
    await deliver('signed', 'tenant@example.com', '2026-11-10T08:00:00+08:00');
    await deliver('signed', PRACTITIONER_EMAIL, '2029-06-01T10:00:00+08:00');
    const [record] = await listSignatureRecords(id, db);
    expect(record.snapshotAtSign).toMatchObject({ result: { signable: false } });
    expect(getContract(id)?.status).toBe('awaiting_landlord');
    expect((await signing.getProgress(subject))?.currentSigner?.role).toBe('party_a');
  });

  it('模擬簽署（mock advance）用模組的現在時間當事件時間', async () => {
    const { id, send, signing, subject } = await setup({ now: () => new Date('2026-11-10T01:30:00.000Z') });
    await send();
    await signing.simulateEvent(subject, 'signed');
    await signing.simulateEvent(subject, 'signed');
    expect((await listSignatureRecords(id, db))[0].snapshotAtSign).toMatchObject({ decidedAt: '2026-11-10T01:30:00.000Z' });
  });

  it('全員完成事件先到：執業人員還沒有 signed 事件時，用完成事件的時間補上', async () => {
    const { id, send, deliver } = await setup();
    await send();
    await deliver('signed', 'tenant@example.com', '2026-11-10T08:00:00+08:00');
    await deliver('completed', 'Server', '2026-11-10T11:00:00+08:00');
    expect(getContract(id)?.status).toBe('completed');
    const [record] = await listSignatureRecords(id, db);
    expect(record.snapshotAtSign?.decidedAt).toBe(new Date(unixOf('2026-11-10T11:00:00+08:00') * 1000).toISOString());
  });

  it('完成事件在 signed 事件之後到：不覆蓋已補的快照', async () => {
    const { id, send, deliver } = await setup();
    await send();
    await deliver('signed', 'tenant@example.com', '2026-11-10T08:00:00+08:00');
    await deliver('signed', PRACTITIONER_EMAIL, '2026-11-10T09:30:00+08:00');
    await deliver('signed', 'wang.jianguo@beichen.example.com', '2026-11-10T10:00:00+08:00');
    await deliver('completed', 'Server', '2026-11-10T10:00:05+08:00');
    expect(getContract(id)?.status).toBe('completed');
    const [record] = await listSignatureRecords(id, db);
    expect(record.snapshotAtSign?.decidedAt).toBe(new Date(unixOf('2026-11-10T09:30:00+08:00') * 1000).toISOString());
  });

  it('webhook 重試的同一次 signed 事件不覆蓋快照', async () => {
    const { id, send, deliver } = await setup();
    await send();
    await deliver('signed', 'tenant@example.com', '2026-11-10T08:00:00+08:00');
    await deliver('signed', PRACTITIONER_EMAIL, '2026-11-10T09:30:00+08:00');
    await deliver('signed', PRACTITIONER_EMAIL, '2026-11-10T09:31:00+08:00');
    const [record] = await listSignatureRecords(id, db);
    expect(record.snapshotAtSign?.decidedAt).toBe(new Date(unixOf('2026-11-10T09:30:00+08:00') * 1000).toISOString());
  });

  it('執業人員拒簽、任務撤回：不補 snapshot_at_sign', async () => {
    const { id, send, deliver } = await setup();
    await send();
    await deliver('signed', 'tenant@example.com', '2026-11-10T08:00:00+08:00');
    await deliver('declined', PRACTITIONER_EMAIL, '2026-11-10T09:30:00+08:00');
    expect(getContract(id)?.status).toBe('declined');
    expect((await listSignatureRecords(id, db))[0].snapshotAtSign).toBeNull();
  });

  it('與簽署進度同交易：進度回滾時 snapshot_at_sign 也回滾', async () => {
    const { id, send, signing, subject } = await setup({
      now: () => new Date('2026-11-10T01:30:00.000Z'),
      wrapSubscriber: (inner) => ({
        ...inner,
        onOutcome: (s, outcome, context) => {
          inner.onOutcome(s, outcome, context);
          if (outcome.type === 'signer_signed' && outcome.signer.role === 'practitioner') throw new Error('後續處理失敗');
        },
      }),
    });
    await send();
    await signing.simulateEvent(subject, 'signed');
    await expect(signing.simulateEvent(subject, 'signed')).rejects.toThrow('後續處理失敗');
    expect((await listSignatureRecords(id, db))[0].snapshotAtSign).toBeNull();
    expect((await signing.getProgress(subject))?.currentSigner?.role).toBe('practitioner');
  });

  it('查不到登錄資料時，簽署進度照常推進，快照記下查不到的原因', async () => {
    const broken: PracticeRegistryResolution = {
      available: true,
      registry: {
        ...createSeedPracticeRegistry({ today: () => SEED_TODAY }),
        getPractitioner: async () => {
          throw new Error('登錄連線逾時');
        },
      },
    };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { id, send, deliver } = await setup({ registry: broken });
    await send();
    await deliver('signed', 'tenant@example.com', '2026-11-10T08:00:00+08:00');
    await deliver('signed', PRACTITIONER_EMAIL, '2026-11-10T09:30:00+08:00');
    expect(getContract(id)?.status).toBe('awaiting_landlord');
    expect((await listSignatureRecords(id, db))[0].snapshotAtSign).toMatchObject({
      unavailable: true,
      reason: expect.stringContaining('登錄連線逾時'),
    });
    spy.mockRestore();
  });

  it('登錄資料來源不可用時（正式金鑰沒有真實 adapter），同樣記下原因', async () => {
    const { id, send, deliver } = await setup({ registry: { available: false, reason: '登錄資料來源不可用' } });
    await send();
    await deliver('signed', 'tenant@example.com', '2026-11-10T08:00:00+08:00');
    await deliver('signed', PRACTITIONER_EMAIL, '2026-11-10T09:30:00+08:00');
    expect((await listSignatureRecords(id, db))[0].snapshotAtSign).toMatchObject({ unavailable: true, reason: '登錄資料來源不可用' });
  });
});

describe('簽署任務完成後的紀錄（P0-12 AC7）', () => {
  it('有款次、簽章人、執業主體、簽署時間', async () => {
    const { id, send, deliver } = await setup();
    await send();
    await deliver('signed', 'tenant@example.com', '2026-11-10T08:00:00+08:00');
    await deliver('signed', PRACTITIONER_EMAIL, '2026-11-10T09:30:00+08:00');
    await deliver('signed', 'wang.jianguo@beichen.example.com', '2026-11-10T10:00:00+08:00');
    await deliver('completed', 'Server', '2026-11-10T10:00:05+08:00');
    const [record] = await listSignatureRecords(id, db);
    const signer = db.prepare('SELECT name, signed_at AS signedAt FROM signers WHERE id = ?').get(record.signerId) as {
      name: string;
      signedAt: string;
    };
    expect(record.statuteRef).toContain('§32');
    expect(signer.name).toBe('陳怡君');
    expect(record.entityId).toBe('org-pe-beichen');
    expect(signer.signedAt).toMatch(/^2026-11-10 /);
    expect(record.snapshotAtSign).not.toBeNull();
  });
});

describe('GET /api/contracts/[id]/signature-records（詳情頁的資料來源）', () => {
  const call = async (id: number) => {
    const res = await getSignatureRecordsRoute(new Request('http://localhost/x'), { params: Promise.resolve({ id: String(id) }) });
    return { status: res.status, json: await res.json() };
  };

  it('包租合約送簽後回一筆，帶簽署人狀態與執業主體名稱', async () => {
    const { id, send } = await setup();
    await send();
    const { status, json } = await call(id);
    expect(status).toBe(200);
    expect(json.data).toHaveLength(1);
    expect(json.data[0]).toMatchObject({
      ruleId: SLOT,
      entityName: '北辰租賃住宅管理股份有限公司',
      signer: { name: '陳怡君', role: 'practitioner', status: 'pending', signedAt: null },
    });
  });

  it('草稿與兩方合約回空陣列，頁面就不顯示分頁', async () => {
    const { id } = await setup();
    expect((await call(id)).json).toEqual({ data: [] });
  });

  it('合約不存在回 404', async () => {
    expect((await call(9999)).status).toBe(404);
  });
});
