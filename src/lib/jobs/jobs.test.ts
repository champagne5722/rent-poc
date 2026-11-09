import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalFileStore } from '../file-store/local-file-store';
import { createContractSubscriber } from '../contract-signing';
import { getContract } from '../contracts';
import { withTx } from '../pg/database';
import { setupRouteDb, type RouteDb } from '../pg/route-test-kit';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import type { SigningDb } from '../signing-module/db';
import { listDeadOutbox, OUTBOX_MAX_RETRIES } from '../signing-module/outbox';
import { createSigningModule } from '../signing-module/module';
import type { SignableDocument, Signer, SigningProvider } from '../signing-module/provider';
import type { ContractFields } from '../types';
import { createJobs, type JobNotifications, type JobSigning } from './jobs';
import { createTimerRegistry } from './timers/registry';

// drain-inbox、drain-outbox、scan-timers 三個 job（ADR-0020 決議 3、7、8，MIL-86）。
// 走 createJobs 的介面，簽署模組用真的（PGlite），簽署服務商用替身。

let kit: RouteDb;
let dataDir: string;

beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());

beforeEach(async () => {
  await kit.reset();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const NOW = new Date('2026-11-09T03:00:00Z');
const inOrg = <T,>(orgId: string, fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId }, fn);

const dbFor = (orgId: string): SigningDb => ({
  requestOrg: async () => ({ kind: 'org', orgId }),
  inOrg: (ctx, fn) => withTx(ctx, fn),
  inControl: (fn) => withTx({ kind: 'control' }, fn),
});

let voidOk = false;
const provider = (taskRef: string): SigningProvider => ({
  id: 'dottedsign',
  mode: 'live',
  unsupported: {},
  createTask: async () => ({ taskRef }),
  getSignLink: async () => 'https://sign.example/abc',
  resend: async () => {},
  voidTask: async () => {
    if (!voidOk) throw new Error('點點簽暫時無法使用');
  },
  downloadFile: async () => new Uint8Array(),
  parseWebhook: (raw) => {
    const { taskRef: ref, email } = JSON.parse(raw) as { taskRef: string; email: string };
    return { kind: 'event', taskRef: ref, event: { type: 'signed', email } };
  },
});

const moduleFor = (orgId: string, taskRef = 'unused') =>
  createSigningModule({ provider: provider(taskRef), subscribers: { contract: createContractSubscriber() }, files: createLocalFileStore(dataDir), db: dbFor(orgId) });

const document: SignableDocument = { fileName: '合約', pdf: new Uint8Array([37, 80, 68, 70]), pageSize: { width: 595, height: 842 } };
const signers: Signer[] = [
  { role: 'party_b', name: '王租客', email: 'tenant@example.com', signatureFields: [] },
  { role: 'party_a', name: '林房東', email: 'landlord@example.com', signatureFields: [] },
];
const FIELDS = { landlordName: '林房東', landlordEmail: 'landlord@example.com', tenantName: '王租客', tenantEmail: 'tenant@example.com' } as ContractFields;

/** 送簽，再撤回。服務商撤回失敗時，撤回留在 outbox 等排程重試。 */
async function sentThenVoidFailed(orgId: string, taskRef: string) {
  const id = newUlid();
  await inOrg(orgId, (tx) =>
    tx.query(`INSERT INTO org.contracts (id, org_id, fields) VALUES ($1, current_setting('app.org_id', true), $2::jsonb)`, [id, JSON.stringify(FIELDS)]),
  );
  const signing = moduleFor(orgId, taskRef);
  const subject = { type: 'contract', id } as const;
  await signing.send(subject, document, signers);
  voidOk = false;
  await expect(signing.voidTask(subject)).rejects.toThrow();
  return { subject, signing };
}

const statusOf = async (orgId: string, id: string) => (await inOrg(orgId, (tx) => getContract(tx, id)))?.status;
const timers = createTimerRegistry();
const noEmails: JobNotifications = { drainEmails: async () => [] };
const jobsWith = (signing: JobSigning, limits?: { inbox?: number; outbox?: number }) =>
  createJobs({ signing, notifications: noEmails, timers, limits });

describe('drain-outbox', () => {
  it('逐組織重試到期的撤回，彙整結果', async () => {
    const a = await sentThenVoidFailed(kit.orgA, 'ta');
    const b = await sentThenVoidFailed(kit.orgB, 'tb');
    voidOk = true;

    const result = await jobsWith(moduleFor(kit.orgA))['drain-outbox']({ now: NOW });

    expect(result).toMatchObject({ processed: 2, done: 2, failed: 0, dead: 0, orgErrors: 0, truncated: false });
    expect(await statusOf(kit.orgA, a.subject.id)).toBe('voided');
    expect(await statusOf(kit.orgB, b.subject.id)).toBe('voided');
  });

  it('每次最多處理 limit 筆，剩下的留給下一次', async () => {
    await sentThenVoidFailed(kit.orgA, 'ta');
    await sentThenVoidFailed(kit.orgB, 'tb');
    voidOk = true;
    const jobs = jobsWith(moduleFor(kit.orgA), { outbox: 1 });

    const first = await jobs['drain-outbox']({ now: NOW });
    expect(first).toMatchObject({ processed: 1, done: 1, truncated: true, limit: 1 });

    const second = await jobs['drain-outbox']({ now: NOW });
    expect(second).toMatchObject({ processed: 1, done: 1 });

    expect(await jobs['drain-outbox']({ now: NOW })).toMatchObject({ processed: 0, truncated: false });
  });

  it('一個組織出錯不影響其他組織', async () => {
    const b = await sentThenVoidFailed(kit.orgB, 'tb');
    voidOk = true;
    const real = moduleFor(kit.orgB);
    const flaky: JobSigning = {
      drainInbox: real.drainInbox,
      drainOutbox: async (orgId, limit) => {
        if (orgId === kit.orgA) throw new Error('A 組織的 drain 出錯');
        return real.drainOutbox(orgId, limit);
      },
    };

    const result = await jobsWith(flaky)['drain-outbox']({ now: NOW });

    expect(result).toMatchObject({ orgErrors: 1, done: 1 });
    expect(await statusOf(kit.orgB, b.subject.id)).toBe('voided');
  });

  it('重試超過 5 次轉人工處理清單，job 結果標出，之後不再重試', async () => {
    const { subject } = await sentThenVoidFailed(kit.orgA, 'ta');
    const jobs = jobsWith(moduleFor(kit.orgA));

    // 請求內的第一次已失敗。排程再試 5 次，第 6 次失敗轉 dead
    for (let i = 1; i < OUTBOX_MAX_RETRIES; i++) {
      expect(await jobs['drain-outbox']({ now: NOW })).toMatchObject({ failed: 1, dead: 0 });
    }
    const last = await jobs['drain-outbox']({ now: NOW });

    expect(last).toMatchObject({ failed: 1, dead: 1 });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('轉人工處理清單'));
    const dead = await inOrg(kit.orgA, (tx) => listDeadOutbox(tx));
    expect(dead.map((r) => r.subject.id)).toEqual([subject.id]);
    expect(await jobs['drain-outbox']({ now: NOW })).toMatchObject({ processed: 0 });
  });
});

describe('drain-outbox：保存文件（MIL-87）', () => {
  it('全員完成時下載失敗的文件，由排程補上並標完成', async () => {
    let downloadOk = false;
    const completing: SigningProvider = {
      ...provider('tf'),
      downloadFile: async (ref, kind) => {
        if (!downloadOk) throw new Error('下載連結回應 503');
        return new TextEncoder().encode(`${kind}-of-${ref}`);
      },
      parseWebhook: () => ({ kind: 'event', taskRef: 'tf', event: { type: 'completed' } }),
    };
    const signing = createSigningModule({
      provider: completing,
      subscribers: { contract: createContractSubscriber() },
      files: createLocalFileStore(dataDir),
      db: dbFor(kit.orgA),
    });
    const id = newUlid();
    await inOrg(kit.orgA, (tx) =>
      tx.query(`INSERT INTO org.contracts (id, org_id, fields) VALUES ($1, current_setting('app.org_id', true), $2::jsonb)`, [id, JSON.stringify(FIELDS)]),
    );
    const subject = { type: 'contract', id } as const;
    await signing.send(subject, document, signers);
    const ack = await signing.ingestWebhook('{}', new Headers());
    expect(ack.status).toBe(200);
    expect(await statusOf(kit.orgA, id)).toBe('completed');
    expect((await signing.listFiles(subject)).map((f) => f.status)).toEqual(['failed', 'failed']);

    downloadOk = true;
    const result = await jobsWith(signing)['drain-outbox']({ now: NOW });

    expect(result).toMatchObject({ processed: 1, done: 1, failed: 0, dead: 0 });
    expect((await signing.listFiles(subject)).map((f) => f.status)).toEqual(['saved', 'saved']);
  });
});

describe('drain-inbox', () => {
  it('重試路由列補上之後的事件，彙整結果', async () => {
    const signing = moduleFor(kit.orgA, 'ti');
    await signing.ingestWebhook(JSON.stringify({ taskRef: 'ti', email: 'tenant@example.com' }), new Headers());
    const id = newUlid();
    await inOrg(kit.orgA, (tx) =>
      tx.query(`INSERT INTO org.contracts (id, org_id, fields) VALUES ($1, current_setting('app.org_id', true), $2::jsonb)`, [id, JSON.stringify(FIELDS)]),
    );
    await signing.send({ type: 'contract', id }, document, signers);

    const result = await jobsWith(signing)['drain-inbox']({ now: NOW });

    expect(result).toMatchObject({ processed: 1, done: 1, deferred: 0, failed: 0, dead: 0, truncated: false });
    expect(await statusOf(kit.orgA, id)).toBe('awaiting_landlord');
  });

  it('每次最多處理 limit 筆', async () => {
    const signing = moduleFor(kit.orgA);
    for (const ref of ['x1', 'x2', 'x3']) {
      await signing.ingestWebhook(JSON.stringify({ taskRef: ref, email: 'a@example.com' }), new Headers());
    }

    const result = await jobsWith(signing, { inbox: 2 })['drain-inbox']({ now: NOW });

    expect(result).toMatchObject({ processed: 2, deferred: 2, limit: 2, truncated: true });
  });

  it('一直找不到路由列的事件超過 5 次轉人工處理清單，job 結果標出', async () => {
    const signing = moduleFor(kit.orgA);
    await signing.ingestWebhook(JSON.stringify({ taskRef: 'ghost', email: 'a@example.com' }), new Headers());
    const jobs = jobsWith(signing);

    for (let i = 1; i < 5; i++) expect(await jobs['drain-inbox']({ now: NOW })).toMatchObject({ dead: 0 });
    expect(await jobs['drain-inbox']({ now: NOW })).toMatchObject({ deferred: 1, dead: 1 });
    expect(await jobs['drain-inbox']({ now: NOW })).toMatchObject({ processed: 0 });
  });
});

describe('scan-timers', () => {
  it('用台灣日期執行已註冊的計時器', async () => {
    const seen: string[] = [];
    const registry = createTimerRegistry();
    registry.register({
      name: 'probe',
      scope: 'global',
      scan: async (_tx, today) => {
        seen.push(today);
        return [{ subjectId: 'S1', event: 'probe_due', date: today }];
      },
      fire: async () => {},
    });
    const jobs = createJobs({ signing: moduleFor(kit.orgA), notifications: noEmails, timers: registry });

    // UTC 16:30 已是台灣的隔天
    const result = await jobs['scan-timers']({ now: new Date('2026-11-09T16:30:00Z') });

    expect(seen).toEqual(['2026-11-10']);
    expect(result).toMatchObject({ today: '2026-11-10', timers: 1, fired: 1, truncated: false });
  });
});
