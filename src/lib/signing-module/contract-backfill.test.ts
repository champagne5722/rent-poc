import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureSchema, getContract, listContractEvents, setDb } from '../db';
import type { ContractStatus } from '../types';
import { createDottedSignProvider } from './dottedsign-adapter';
import { createMockProvider } from './mock-adapter';
import { createSigningModule } from './module';
import type { SigningProvider } from './provider';

// 既有合約的回填（MIL-56）：先寫入升級前的資料，再執行 ensureSchema()，之後一律經簽署模組介面檢查。

let db: Database.Database;
// 文件本體寫在暫存目錄，不碰 data/
let dataDir: string;

beforeEach(() => {
  db = new Database(':memory:');
  ensureSchema(db);
  setDb(db);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-backfill-'));
});

afterEach(() => {
  setDb(null);
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
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

const mockSigning = () => createSigningModule({ provider: createMockProvider(), dataDir });

const liveProvider = (overrides: Partial<SigningProvider> = {}): SigningProvider => ({
  id: 'dottedsign',
  mode: 'live',
  unsupported: { simulate: 'live 模式下請走真實 webhook' },
  createTask: async () => ({ taskRef: '470' }),
  getSignLink: async () => 'https://sign.example/abc',
  resend: async () => {},
  voidTask: async () => {},
  downloadFile: async () => {
    throw new Error('不應呼叫服務商下載');
  },
  parseWebhook: () => ({ kind: 'ignored' }),
  ...overrides,
});

const webhook = (taskRef: string, action: string) =>
  JSON.stringify({ resource_id: taskRef, resource_type: 'task', action_name: action });

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

    await mockSigning().ingestWebhook(webhook('mock-1-a', 'signed'), new Headers());

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
    const live = createSigningModule({ provider: liveProvider({ parseWebhook }), dataDir });

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
    const live = createSigningModule({
      provider: createDottedSignProvider({ request: async () => ({}), clientSecret }),
      dataDir,
    });
    const body = webhook('470', 'signed');
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

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const signing = mockSigning();
    await expect(signing.simulateEvent(subject, 'signed')).resolves.toEqual({ status: 'awaiting_landlord' });
    await expect(signing.simulateEvent(subject, 'completed')).resolves.toEqual({ status: 'completed' });

    const progress = await signing.getProgress(subject);
    expect(progress?.status).toBe('completed');
    expect(progress?.signers.map((s) => s.status)).toEqual(['signed', 'signed']);
    expect(listContractEvents(subject.id, db).map((e) => e.type)).toEqual(['sent', 'tenant_signed', 'completed']);
    // 升級前送簽的 mock 任務沒有保存 PDF，完成時保存失敗並留下紀錄，狀態照常完成
    expect((await signing.listFiles(subject)).map((f) => [f.kind, f.status, f.error])).toEqual([
      ['signed_pdf', 'failed', 'mock 模式找不到送簽時的 PDF'],
    ]);
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
    const live = createSigningModule({ provider: liveProvider({ getSignLink, resend }), dataDir });

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

// 升級前的合約文件紀錄：檔案在 data/contract-files/<合約 id>/，以合約為鍵
function legacyFile(
  contractId: number,
  kind: 'signed_pdf' | 'audit_trail',
  row: { status: 'saved' | 'failed'; error?: string; content?: string }
) {
  const suffix = kind === 'signed_pdf' ? 'signed' : 'audit-trail';
  const fileName = `contract-${contractId}-${suffix}.pdf`;
  const relPath = row.status === 'saved' ? `contract-files/${contractId}/${fileName}` : null;
  if (relPath) {
    fs.mkdirSync(path.join(dataDir, `contract-files/${contractId}`), { recursive: true });
    fs.writeFileSync(path.join(dataDir, relPath), row.content ?? `legacy-${kind}`);
  }
  db.prepare(
    `INSERT INTO contract_files (contract_id, kind, status, file_name, rel_path, byte_size, content_type, error, saved_at)
     VALUES (?, ?, ?, ?, ?, ?, 'application/pdf', ?, '2026-01-05 09:00:00')`
  ).run(contractId, kind, row.status, fileName, relPath, relPath ? 10 : null, row.error ?? null);
}

describe('回填的合約文件', () => {
  it('既有文件紀錄轉入，舊檔案路徑不搬，不呼叫服務商就能下載', async () => {
    const subject = legacyContract('completed', '470');
    legacyFile(subject.id, 'signed_pdf', { status: 'saved', content: 'old-signed' });
    legacyFile(subject.id, 'audit_trail', { status: 'saved', content: 'old-audit' });
    upgrade();

    const live = createSigningModule({ provider: liveProvider(), dataDir });
    const files = await live.listFiles(subject);
    expect(files.map((f) => [f.kind, f.status, f.rel_path, f.saved_at])).toEqual([
      ['audit_trail', 'saved', `contract-files/${subject.id}/contract-${subject.id}-audit-trail.pdf`, '2026-01-05 09:00:00'],
      ['signed_pdf', 'saved', `contract-files/${subject.id}/contract-${subject.id}-signed.pdf`, '2026-01-05 09:00:00'],
    ]);
    const signed = await live.downloadFile(subject, 'signed_pdf');
    expect(new TextDecoder().decode(signed.bytes)).toBe('old-signed');
    expect(signed.fileName).toBe(`contract-${subject.id}-signed.pdf`);
    expect(new TextDecoder().decode((await live.downloadFile(subject, 'audit_trail')).bytes)).toBe('old-audit');
  });

  it('保存失敗的紀錄也轉入，補抓後覆蓋', async () => {
    const subject = legacyContract('completed', '470');
    legacyFile(subject.id, 'audit_trail', { status: 'failed', error: '下載連結回應 403' });
    upgrade();

    const live = createSigningModule({
      provider: liveProvider({ downloadFile: async () => new TextEncoder().encode('new') }),
      dataDir,
    });
    expect((await live.listFiles(subject)).map((f) => [f.kind, f.status, f.error])).toEqual([
      ['audit_trail', 'failed', '下載連結回應 403'],
    ]);
    await live.saveFiles(subject, { kinds: ['audit_trail'], force: true });
    expect((await live.listFiles(subject)).map((f) => [f.kind, f.status, f.error])).toEqual([
      ['audit_trail', 'saved', null],
    ]);
  });

  it('升級前完成的 mock 合約仍能下載已保存的已簽 PDF', async () => {
    const subject = legacyContract('completed', 'mock-3-c');
    legacyFile(subject.id, 'signed_pdf', { status: 'saved', content: 'old-mock' });
    upgrade();

    const file = await mockSigning().downloadFile(subject, 'signed_pdf');
    expect(new TextDecoder().decode(file.bytes)).toBe('old-mock');
  });

  it('重跑回填不覆蓋之後的保存結果', async () => {
    const subject = legacyContract('completed', '470');
    legacyFile(subject.id, 'signed_pdf', { status: 'saved', content: 'old-signed' });
    upgrade();
    const live = createSigningModule({
      provider: liveProvider({ downloadFile: async () => new TextEncoder().encode('refetched') }),
      dataDir,
    });
    await live.saveFiles(subject, { kinds: ['signed_pdf'], force: true });

    upgrade();

    expect(new TextDecoder().decode((await live.downloadFile(subject, 'signed_pdf')).bytes)).toBe('refetched');
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

  it('合約文件對不到簽署任務時略過，不擋住開檔', async () => {
    const subject = legacyContract('completed', null);
    legacyFile(subject.id, 'signed_pdf', { status: 'saved' });

    expect(upgrade).not.toThrow();
    await expect(mockSigning().listFiles(subject)).resolves.toEqual([]);
  });

  it('簽署人欄位不是字串時記為空字串，不擋住開檔', async () => {
    const subject = legacyContract('awaiting_tenant', 'mock-1-a', JSON.stringify({ tenantName: { a: 1 }, tenantEmail: 7 }));

    expect(upgrade).not.toThrow();

    const progress = await mockSigning().getProgress(subject);
    expect(progress?.currentSigner).toEqual({ role: 'party_b', name: '', email: '' });
  });
});
