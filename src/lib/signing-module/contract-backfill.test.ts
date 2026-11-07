import Database from 'better-sqlite3';
import crypto from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureSchema, getContract, listContractEvents, setDb } from '../db';
import type { ContractStatus } from '../types';
import { createDottedSignProvider } from './dottedsign-adapter';
import { createContractSubscriber } from '../contract-signing';
import { createMockProvider } from './mock-adapter';
import { createSigningModule } from './module';
import type { SigningProvider } from './provider';

// 既有合約的回填（MIL-56）：先寫入升級前的資料，再執行 ensureSchema()，之後一律經簽署模組介面檢查。

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  ensureSchema(db);
  setDb(db);
});

afterEach(() => {
  setDb(null);
  db.close();
  vi.restoreAllMocks();
});

const FIELDS = JSON.stringify({
  landlordName: '林房東',
  landlordEmail: 'landlord@example.com',
  tenantName: '王租客',
  tenantEmail: 'tenant@example.com',
});

const TENANT = { role: 'party_b', name: '王租客', email: 'tenant@example.com' };
const LANDLORD = { role: 'party_a', name: '林房東', email: 'landlord@example.com' };

function legacyContract(status: ContractStatus, taskRef: string | null, fields = FIELDS) {
  const result = db
    .prepare(
      `INSERT INTO contracts (status, fields, dottedsign_task_id, created_at, updated_at)
       VALUES (?, ?, ?, '2026-01-01 09:00:00', '2026-01-05 09:00:00')`
    )
    .run(status, fields, taskRef);
  return { type: 'contract', id: Number(result.lastInsertRowid) } as const;
}

function legacyEvent(contractId: number, type: string, actor: string, createdAt: string) {
  db.prepare('INSERT INTO contract_events (contract_id, type, actor, created_at) VALUES (?, ?, ?, ?)').run(
    contractId,
    type,
    actor,
    createdAt
  );
}

const upgrade = () => ensureSchema(db);

const moduleOf = (provider: SigningProvider, onCompleted: () => Promise<void> = async () => {}) =>
  createSigningModule({ provider, subscribers: { contract: createContractSubscriber({ onCompleted }) } });
const mockSigning = () => moduleOf(createMockProvider());

const liveProvider = (overrides: Partial<SigningProvider> = {}): SigningProvider => ({
  id: 'dottedsign',
  mode: 'live',
  unsupported: { simulate: 'live 模式下請走真實 webhook' },
  createTask: async () => ({ taskRef: '470' }),
  getSignLink: async () => 'https://sign.example/abc',
  resend: async () => {},
  voidTask: async () => {},
  parseWebhook: () => ({ kind: 'ignored' }),
  ...overrides,
});

const webhook = (taskRef: string, action: string, email?: string) =>
  JSON.stringify({ resource_id: taskRef, resource_type: 'task', action_name: action, event_email: email });

describe('回填的簽署進度', () => {
  it('待乙方簽：兩位都待簽，當前簽署人是乙方', async () => {
    const subject = legacyContract('awaiting_tenant', 'mock-1-a');
    upgrade();

    await expect(mockSigning().getProgress(subject)).resolves.toEqual({
      status: 'in_progress',
      signers: [
        { ...TENANT, status: 'pending', signedAt: null },
        { ...LANDLORD, status: 'pending', signedAt: null },
      ],
      currentSigner: TENANT,
    });
  });

  it('待甲方簽：乙方已簽，簽署時間取自合約歷程，當前簽署人是甲方', async () => {
    const subject = legacyContract('awaiting_landlord', 'mock-1-a');
    legacyEvent(subject.id, 'tenant_signed', 'tenant', '2026-01-02 10:00:00');
    upgrade();

    await expect(mockSigning().getProgress(subject)).resolves.toEqual({
      status: 'in_progress',
      signers: [
        { ...TENANT, status: 'signed', signedAt: '2026-01-02 10:00:00' },
        { ...LANDLORD, status: 'pending', signedAt: null },
      ],
      currentSigner: LANDLORD,
    });
  });

  it('已完成：兩位都已簽，甲方的簽署時間是完成時間', async () => {
    const subject = legacyContract('completed', 'mock-1-a');
    legacyEvent(subject.id, 'tenant_signed', 'tenant', '2026-01-02 10:00:00');
    legacyEvent(subject.id, 'completed', 'landlord', '2026-01-03 10:00:00');
    upgrade();

    await expect(mockSigning().getProgress(subject)).resolves.toEqual({
      status: 'completed',
      signers: [
        { ...TENANT, status: 'signed', signedAt: '2026-01-02 10:00:00' },
        { ...LANDLORD, status: 'signed', signedAt: '2026-01-03 10:00:00' },
      ],
      currentSigner: null,
    });
  });

  it('已完成但歷程沒有乙方簽署：乙方的簽署時間用完成時間', async () => {
    const subject = legacyContract('completed', 'mock-1-a');
    legacyEvent(subject.id, 'completed', 'landlord', '2026-01-03 10:00:00');
    upgrade();

    const progress = await mockSigning().getProgress(subject);
    expect(progress?.signers.map((s) => s.signedAt)).toEqual(['2026-01-03 10:00:00', '2026-01-03 10:00:00']);
  });

  it('已完成但沒有任何歷程：簽署時間用合約的更新時間', async () => {
    const subject = legacyContract('completed', 'mock-1-a');
    upgrade();

    const progress = await mockSigning().getProgress(subject);
    expect(progress?.signers.map((s) => s.signedAt)).toEqual(['2026-01-05 09:00:00', '2026-01-05 09:00:00']);
  });

  it('乙方拒簽：乙方標為拒簽，甲方維持待簽', async () => {
    const subject = legacyContract('declined', 'mock-1-a');
    legacyEvent(subject.id, 'declined', 'tenant', '2026-01-02 10:00:00');
    upgrade();

    const progress = await mockSigning().getProgress(subject);
    expect(progress?.status).toBe('declined');
    expect(progress?.signers.map((s) => s.status)).toEqual(['declined', 'pending']);
    expect(progress?.currentSigner).toBeNull();
  });

  it('甲方拒簽：乙方已簽，甲方標為拒簽', async () => {
    const subject = legacyContract('declined', 'mock-1-a');
    legacyEvent(subject.id, 'tenant_signed', 'tenant', '2026-01-02 10:00:00');
    legacyEvent(subject.id, 'declined', 'landlord', '2026-01-03 10:00:00');
    upgrade();

    const progress = await mockSigning().getProgress(subject);
    expect(progress?.status).toBe('declined');
    expect(progress?.signers.map((s) => [s.status, s.signedAt])).toEqual([
      ['signed', '2026-01-02 10:00:00'],
      ['declined', null],
    ]);
  });

  it.each([
    ['乙方簽署前撤回', [], ['pending', 'pending']],
    ['乙方簽署後撤回', [['tenant_signed', 'tenant']], ['signed', 'pending']],
  ])('%s：任務已撤回', async (_label, events, expected) => {
    const subject = legacyContract('voided', 'mock-1-a');
    for (const [type, actor] of events) legacyEvent(subject.id, type, actor, '2026-01-02 10:00:00');
    upgrade();

    const progress = await mockSigning().getProgress(subject);
    expect(progress?.status).toBe('voided');
    expect(progress?.signers.map((s) => s.status)).toEqual(expected);
    expect(progress?.currentSigner).toBeNull();
  });

  it('草稿不回填，之後能照常送簽', async () => {
    const subject = legacyContract('draft', null);
    upgrade();

    const signing = mockSigning();
    await expect(signing.getProgress(subject)).resolves.toBeNull();
    await signing.send(
      subject,
      { fileName: 'a', pdf: new Uint8Array([1]), pageSize: { width: 1, height: 1 } },
      [{ ...TENANT, role: 'party_b', signatureFields: [] }]
    );
    await expect(signing.getProgress(subject)).resolves.toMatchObject({ status: 'in_progress' });
  });

  it('簽署中但沒有任務編號的合約不回填，仍能撤回', async () => {
    const subject = legacyContract('awaiting_tenant', null);
    upgrade();

    const signing = mockSigning();
    await expect(signing.getProgress(subject)).resolves.toBeNull();
    await signing.voidTask(subject);
    expect(getContract(subject.id)?.status).toBe('voided');
  });
});

describe('回填的服務商', () => {
  it('任務編號以 mock- 開頭時記為 Mock：Mock 的 webhook 對得到', async () => {
    const subject = legacyContract('awaiting_tenant', 'mock-1-a');
    upgrade();

    await mockSigning().ingestWebhook(webhook('mock-1-a', 'signed', TENANT.email), new Headers());

    expect(getContract(subject.id)?.status).toBe('awaiting_landlord');
  });

  it('任務編號以 mock- 開頭時，點點簽的 webhook 對不到', async () => {
    const subject = legacyContract('awaiting_tenant', 'mock-1-a');
    upgrade();
    const parseWebhook: SigningProvider['parseWebhook'] = () => ({
      kind: 'event',
      taskRef: 'mock-1-a',
      event: { type: 'signed' },
    });
    const live = moduleOf(liveProvider({ parseWebhook }));

    await expect(live.ingestWebhook('{}', new Headers())).resolves.toEqual({
      status: 200,
      body: { ok: true, ignored: true },
    });
    expect(getContract(subject.id)?.status).toBe('awaiting_tenant');
  });

  it('其他任務編號記為點點簽：點點簽的 webhook 對得到，Mock 對不到', async () => {
    const subject = legacyContract('awaiting_tenant', '470');
    upgrade();

    await expect(mockSigning().ingestWebhook(webhook('470', 'signed'), new Headers())).resolves.toEqual({
      status: 200,
      body: { ok: true, ignored: true },
    });
    expect(getContract(subject.id)?.status).toBe('awaiting_tenant');

    const clientSecret = 'test-secret';
    const live = moduleOf(createDottedSignProvider({ request: async () => ({}), clientSecret }));
    const body = webhook('470', 'signed', TENANT.email);
    const signature = crypto.createHmac('sha256', clientSecret).update(body).digest('hex');
    await live.ingestWebhook(body, new Headers({ signature }));
    expect(getContract(subject.id)?.status).toBe('awaiting_landlord');
  });
});

describe('升級後繼續走完', () => {
  it('回填後的待乙方簽合約，能經 mock advance 走到完成', async () => {
    const subject = legacyContract('awaiting_tenant', 'mock-1-a');
    legacyEvent(subject.id, 'sent', 'landlord', '2026-01-01 10:00:00');
    upgrade();

    const onCompleted = vi.fn(async () => {});
    const signing = moduleOf(createMockProvider(), onCompleted);
    await expect(signing.simulateEvent(subject, 'signed')).resolves.toEqual({ status: 'awaiting_landlord' });
    await expect(signing.simulateEvent(subject, 'completed')).resolves.toEqual({ status: 'completed' });

    const progress = await signing.getProgress(subject);
    expect(progress?.status).toBe('completed');
    expect(progress?.signers.map((s) => s.status)).toEqual(['signed', 'signed']);
    expect(listContractEvents(subject.id, db).map((e) => e.type)).toEqual(['sent', 'signer_signed', 'completed']);
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });

  it('回填後的待甲方簽合約，能走到完成，乙方的簽署時間不被覆蓋', async () => {
    const subject = legacyContract('awaiting_landlord', 'mock-1-a');
    legacyEvent(subject.id, 'tenant_signed', 'tenant', '2026-01-02 10:00:00');
    upgrade();

    const signing = mockSigning();
    await signing.simulateEvent(subject, 'completed');

    const progress = await signing.getProgress(subject);
    expect(progress?.signers[0].signedAt).toBe('2026-01-02 10:00:00');
    expect(progress?.signers[1].status).toBe('signed');
  });

  it('回填後的簽署中合約，簽署連結與重寄的對象由簽署進度決定', async () => {
    const subject = legacyContract('awaiting_landlord', '470');
    legacyEvent(subject.id, 'tenant_signed', 'tenant', '2026-01-02 10:00:00');
    upgrade();

    const getSignLink = vi.fn(async () => 'https://sign.example/abc');
    const resend = vi.fn(async () => {});
    const live = moduleOf(liveProvider({ getSignLink, resend }));

    await expect(live.getSignLink(subject)).resolves.toEqual({ signer: LANDLORD, url: 'https://sign.example/abc' });
    await expect(live.resend(subject)).resolves.toEqual({ signer: LANDLORD });
    expect(getSignLink).toHaveBeenCalledWith('470', 'landlord@example.com', undefined);
    expect(resend).toHaveBeenCalledWith('470');
  });
});

describe('回填能重複執行', () => {
  it('第二次執行不改任何簽署進度', async () => {
    const subjects = [
      legacyContract('awaiting_tenant', 'mock-1-a'),
      legacyContract('awaiting_landlord', 'mock-2-b'),
      legacyContract('completed', 'mock-3-c'),
      legacyContract('declined', 'mock-4-d'),
      legacyContract('voided', 'mock-5-e'),
    ];
    upgrade();
    const signing = mockSigning();
    const first = await Promise.all(subjects.map((s) => signing.getProgress(s)));
    expect(first.every(Boolean)).toBe(true);

    upgrade();

    await expect(Promise.all(subjects.map((s) => signing.getProgress(s)))).resolves.toEqual(first);
    expect(getContract(subjects[0].id)?.status).toBe('awaiting_tenant');
  });

  it('推進後再執行，簽署進度不會退回', async () => {
    const subject = legacyContract('awaiting_tenant', 'mock-1-a');
    upgrade();
    const signing = mockSigning();
    await signing.simulateEvent(subject, 'signed');
    const advanced = await signing.getProgress(subject);

    upgrade();

    await expect(signing.getProgress(subject)).resolves.toEqual(advanced);
  });

  it('升級後才簽署中的合約，再執行不會多建簽署任務', async () => {
    const subject = legacyContract('draft', null);
    upgrade();
    const signing = mockSigning();
    await signing.send(
      subject,
      { fileName: 'a', pdf: new Uint8Array([1]), pageSize: { width: 1, height: 1 } },
      [
        { ...TENANT, role: 'party_b', signatureFields: [] },
        { ...LANDLORD, role: 'party_a', signatureFields: [] },
      ]
    );
    const before = await signing.getProgress(subject);

    upgrade();

    await expect(signing.getProgress(subject)).resolves.toEqual(before);
  });
});

describe('回填遇到壞資料', () => {
  it('合約欄位不是合法 JSON 時略過該列，其他合約照常回填，不擋住開檔', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = legacyContract('awaiting_tenant', 'mock-1-a', '{not json');
    const good = legacyContract('awaiting_tenant', 'mock-2-b');

    expect(upgrade).not.toThrow();

    const signing = mockSigning();
    await expect(signing.getProgress(broken)).resolves.toBeNull();
    await expect(signing.getProgress(good)).resolves.toMatchObject({ status: 'in_progress' });
  });

  it('兩份合約共用任務編號時，第二份略過，不擋住開檔', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = legacyContract('awaiting_tenant', '470');
    const second = legacyContract('awaiting_tenant', '470');

    expect(upgrade).not.toThrow();

    const signing = mockSigning();
    await expect(signing.getProgress(first)).resolves.toMatchObject({ status: 'in_progress' });
    await expect(signing.getProgress(second)).resolves.toBeNull();
  });

  it('合約欄位缺簽署人資料時，姓名與 email 記為空字串', async () => {
    const subject = legacyContract('awaiting_tenant', 'mock-1-a', '{}');
    upgrade();

    const progress = await mockSigning().getProgress(subject);
    expect(progress?.currentSigner).toEqual({ role: 'party_b', name: '', email: '' });
  });

  it('簽署人欄位不是字串時記為空字串，不擋住開檔', async () => {
    const subject = legacyContract('awaiting_tenant', 'mock-1-a', JSON.stringify({ tenantName: { a: 1 }, tenantEmail: 7 }));

    expect(upgrade).not.toThrow();

    const progress = await mockSigning().getProgress(subject);
    expect(progress?.currentSigner).toEqual({ role: 'party_b', name: '', email: '' });
  });
});
