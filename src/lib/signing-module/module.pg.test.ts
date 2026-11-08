import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createContractSubscriber } from '../contract-signing';
import { getContract, listContractEvents } from '../contracts';
import { pgDriver } from '../pg/drivers';
import { createPgTestDatabase, type PgTestDatabase } from '../pg/pg-database-kit';
import { newUlid } from '../pg/ulid';
import { createWithTx, type OrgTx, type WithTx } from '../pg/with-tx';
import type { ContractFields } from '../types';
import type { SigningDb } from './db';
import { createMockProvider } from './mock-adapter';
import { createSigningModule } from './module';
import type { SignableDocument, Signer, SigningProvider } from './provider';

// 真實 PostgreSQL（pg 驅動、連線池 6 條、app_rw）。PGlite 只有一條連線，交易之間排隊，測不出列鎖。
// 這裡驗證 MIL-85 倚賴列鎖與唯一索引的行為：同一個事件並發只套用一次、並發送簽只建一個服務商任務。
// 只在有 TEST_DATABASE_URL 時執行（見 pg-integration.test.ts）。

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('簽署模組（真實 PostgreSQL）', () => {
  let dbh: PgTestDatabase;
  let withTx: WithTx;
  let dataDir: string;
  const orgA = newUlid();

  beforeAll(async () => {
    dbh = await createPgTestDatabase(adminUrl!, 6);
    withTx = createWithTx(pgDriver(dbh.pool));
    await dbh.owner.query(
      `SET ROLE app_owner; INSERT INTO control.orgs (id, name, kind) VALUES ('${orgA}', 'A', 'owner'); RESET ROLE`,
    );
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signing-pg-'));
  });
  afterAll(async () => {
    await dbh.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const inA = <T>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: orgA }, fn);
  const db: SigningDb = {
    requestOrg: async () => ({ kind: 'org', orgId: orgA }),
    inOrg: (ctx, fn) => withTx(ctx, fn),
    inControl: (fn) => withTx({ kind: 'control' }, fn),
  };
  const moduleWith = (provider: SigningProvider) =>
    createSigningModule({ provider, subscribers: { contract: createContractSubscriber() }, dataDir, db });

  const liveProvider = (overrides: Partial<SigningProvider> = {}): SigningProvider => ({
    ...createMockProvider(),
    id: 'dottedsign',
    mode: 'live',
    unsupported: {},
    createTask: async () => ({ taskRef: newUlid() }),
    voidTask: async () => {},
    resend: async () => {},
    downloadFile: async (ref, kind) => new TextEncoder().encode(`${kind}-${ref}`),
    ...overrides,
  });

  const FIELDS = { landlordName: '林房東', landlordEmail: 'l@example.com', tenantName: '王租客', tenantEmail: 't@example.com' } as ContractFields;
  const document: SignableDocument = { fileName: 'x', pdf: new Uint8Array([37, 80, 68, 70]), pageSize: { width: 1, height: 1 } };
  const signers: Signer[] = [
    { role: 'party_b', name: '王租客', email: 't@example.com', signatureFields: [] },
    { role: 'party_a', name: '林房東', email: 'l@example.com', signatureFields: [] },
  ];
  async function newDraft() {
    const id = newUlid();
    await inA((tx) =>
      tx.query(`INSERT INTO org.contracts (id, org_id, fields) VALUES ($1, current_setting('app.org_id', true), $2::jsonb)`, [id, JSON.stringify(FIELDS)]),
    );
    return { type: 'contract', id } as const;
  }
  const statusOf = async (id: string) => (await inA((tx) => getContract(tx, id)))?.status;
  const eventTypes = async (id: string) => (await inA((tx) => listContractEvents(tx, id))).map((e) => e.type);

  it('送簽、簽署、完成、保存文件：jsonb、timestamptz 與路由列在 pg 驅動下一樣正確', async () => {
    const subject = await newDraft();
    const provider = liveProvider({
      createTask: async () => ({ taskRef: 'pg-task-1' }),
      parseWebhook: (raw) => {
        const { action, email } = JSON.parse(raw) as { action: 'signed' | 'completed'; email?: string };
        return { kind: 'event', taskRef: 'pg-task-1', event: { type: action, email, occurredAt: '2026-11-09T01:02:03.000Z' } };
      },
    });
    const signing = moduleWith(provider);
    await signing.send(subject, document, [{ ...signers[0], concurrentRoles: ['party_a'] }, signers[1]]);

    await signing.ingestWebhook(JSON.stringify({ action: 'signed', email: 't@example.com' }), new Headers());
    await signing.ingestWebhook(JSON.stringify({ action: 'completed' }), new Headers());

    expect(await statusOf(subject.id)).toBe('completed');
    const progress = await signing.getProgress(subject);
    expect(progress?.signers[0]).toMatchObject({ role: 'party_b', status: 'signed', concurrentRoles: ['party_a'], signedAt: '2026-11-09T01:02:03.000Z' });
    expect((await signing.listFiles(subject)).map((f) => [f.kind, f.status])).toEqual([['audit_trail', 'saved'], ['signed_pdf', 'saved']]);
  });

  it('同一個 signed 事件並發送來 4 次：列鎖讓它們依序處理，只套用一次', async () => {
    const subject = await newDraft();
    const provider = liveProvider({
      createTask: async () => ({ taskRef: 'pg-task-2' }),
      parseWebhook: () => ({ kind: 'event', taskRef: 'pg-task-2', event: { type: 'signed', email: 't@example.com' } }),
    });
    const signing = moduleWith(provider);
    await signing.send(subject, document, signers);

    const acks = await Promise.all(Array.from({ length: 4 }, () => signing.ingestWebhook('{}', new Headers())));

    expect(acks.every((a) => a.status === 200)).toBe(true);
    expect(acks.filter((a) => !('ignored' in a.body))).toHaveLength(1);
    expect(await eventTypes(subject.id)).toEqual(['sent', 'signer_signed']);
    expect((await signing.getProgress(subject))?.signers.map((s) => s.status)).toEqual(['signed', 'pending']);
  });

  it('同一份合約並發送簽 4 次：只建立一個服務商任務，其餘 409', async () => {
    const subject = await newDraft();
    const createTask = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return { taskRef: newUlid() };
    });
    const signing = moduleWith(liveProvider({ createTask }));

    const results = await Promise.allSettled(Array.from({ length: 4 }, () => signing.send(subject, document, signers)));

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected' && (r.reason as { status?: number }).status === 409)).toHaveLength(3);
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(await eventTypes(subject.id)).toEqual(['sent']);
  });

  it('撤回與全員完成事件並發：不是撤回成功就是 409，合約不會同時是兩種結果', async () => {
    const subject = await newDraft();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const provider = liveProvider({
      createTask: async () => ({ taskRef: 'pg-task-3' }),
      voidTask: async () => gate,
      parseWebhook: () => ({ kind: 'event', taskRef: 'pg-task-3', event: { type: 'completed' } }),
    });
    const signing = moduleWith(provider);
    await signing.send(subject, document, signers);

    const voiding = signing.voidTask(subject);
    // 撤回卡在服務商呼叫時，完成事件先到
    await vi.waitFor(async () => expect((await inA((tx) => tx.query(`SELECT 1 FROM org.outbox WHERE status = 'sending'`))).rows).toHaveLength(1));
    await signing.ingestWebhook('{}', new Headers());
    release();

    await expect(voiding).rejects.toMatchObject({ status: 409 });
    expect(await statusOf(subject.id)).toBe('completed');
    expect(await eventTypes(subject.id)).toEqual(['sent', 'completed']);
  });

  it('同一個服務商任務編號不能跨組織使用（路由列主鍵）', async () => {
    const orgB = newUlid();
    await dbh.owner.query(`SET ROLE app_owner; INSERT INTO control.orgs (id, name, kind) VALUES ('${orgB}', 'B', 'owner'); RESET ROLE`);
    const provider = liveProvider({ createTask: async () => ({ taskRef: 'pg-shared' }) });
    const first = await newDraft();
    await moduleWith(provider).send(first, document, signers);

    const inB = <T>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: orgB }, fn);
    const secondId = newUlid();
    await inB((tx) => tx.query(`INSERT INTO org.contracts (id, org_id, fields) VALUES ($1, current_setting('app.org_id', true), $2::jsonb)`, [secondId, JSON.stringify(FIELDS)]));
    const asB = createSigningModule({
      provider,
      subscribers: { contract: createContractSubscriber() },
      dataDir,
      db: { ...db, requestOrg: async () => ({ kind: 'org', orgId: orgB }) },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(asB.send({ type: 'contract', id: secondId }, document, signers)).rejects.toMatchObject({ status: 409 });
    expect((await inB((tx) => getContract(tx, secondId)))?.status).toBe('draft');
  });
});
