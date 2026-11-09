import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createContractSubscriber } from '../contract-signing';
import { getContract } from '../contracts';
import { pgDriver } from '../pg/drivers';
import { createPgTestDatabase, type PgTestDatabase } from '../pg/pg-database-kit';
import { newUlid } from '../pg/ulid';
import { createWithTx, type OrgTx, type WithTx } from '../pg/with-tx';
import type { SigningDb } from '../signing-module/db';
import { createSigningModule } from '../signing-module/module';
import type { SignableDocument, Signer, SigningProvider } from '../signing-module/provider';
import type { ContractFields } from '../types';

// 真實 PostgreSQL（pg 驅動、連線池 6 條、app_rw）。PGlite 只有一條連線，測不出 FOR UPDATE SKIP LOCKED。
// 驗證 MIL-86 的認領：多個排程同時跑，每一列只處理一次，被鎖住的列直接略過、不等待。
// 只在有 TEST_DATABASE_URL 時執行（見 pg-integration.test.ts）。

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('job 的認領（真實 PostgreSQL）', () => {
  let dbh: PgTestDatabase;
  let withTx: WithTx;
  let dataDir: string;
  const orgA = newUlid();

  beforeAll(async () => {
    dbh = await createPgTestDatabase(adminUrl!, 6);
    withTx = createWithTx(pgDriver(dbh.pool));
    await dbh.owner.query(`SET ROLE app_owner; INSERT INTO control.orgs (id, name, kind) VALUES ('${orgA}', 'A', 'owner'); RESET ROLE`);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-pg-'));
  });
  afterAll(async () => {
    await dbh.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const inA = <T,>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: orgA }, fn);
  const db: SigningDb = {
    requestOrg: async () => ({ kind: 'org', orgId: orgA }),
    inOrg: (ctx, fn) => withTx(ctx, fn),
    inControl: (fn) => withTx({ kind: 'control' }, fn),
  };

  const FIELDS = { landlordName: '林', landlordEmail: 'l@example.com', tenantName: '王', tenantEmail: 't@example.com' } as ContractFields;
  const document: SignableDocument = { fileName: '合約', pdf: new Uint8Array([37]), pageSize: { width: 595, height: 842 } };
  const signers: Signer[] = [
    { role: 'party_b', name: '王', email: 't@example.com', signatureFields: [] },
    { role: 'party_a', name: '林', email: 'l@example.com', signatureFields: [] },
  ];

  const voidCalls: string[] = [];
  let voidOk = false;
  const provider = (createTask: SigningProvider['createTask']): SigningProvider => ({
    id: 'dottedsign',
    mode: 'live',
    unsupported: {},
    createTask,
    getSignLink: async () => 'https://sign.example/abc',
    resend: async () => {},
    voidTask: async (ref) => {
      voidCalls.push(ref);
      if (!voidOk) throw new Error('暫時失敗');
    },
    downloadFile: async () => new Uint8Array(),
    parseWebhook: (raw) => {
      const { taskRef, email } = JSON.parse(raw) as { taskRef: string; email: string };
      return { kind: 'event', taskRef, event: { type: 'signed', email } };
    },
  });
  const moduleWith = (createTask: SigningProvider['createTask'] = async () => ({ taskRef: newUlid() })) =>
    createSigningModule({ provider: provider(createTask), subscribers: { contract: createContractSubscriber() }, dataDir, db });

  async function sentContract(taskRef: string) {
    const id = newUlid();
    await inA((tx) =>
      tx.query(`INSERT INTO org.contracts (id, org_id, fields) VALUES ($1, current_setting('app.org_id', true), $2::jsonb)`, [id, JSON.stringify(FIELDS)]),
    );
    const subject = { type: 'contract', id } as const;
    await moduleWith(async () => ({ taskRef })).send(subject, document, signers);
    return subject;
  }

  it('三個 drain-inbox 同時跑：每個事件只處理一次（attempts 都是 1），合約都推進', async () => {
    // 先讓事件留在 inbox：任務編號對不到路由列
    const early = moduleWith();
    const refs = Array.from({ length: 6 }, (_, i) => `inbox-${newUlid()}-${i}`);
    for (const ref of refs) await early.ingestWebhook(JSON.stringify({ taskRef: ref, email: 't@example.com' }), new Headers());
    const subjects = [];
    for (const ref of refs) subjects.push(await sentContract(ref));

    const runs = await Promise.all([early.drainInbox(10), early.drainInbox(10), early.drainInbox(10)]);

    const results = runs.flat();
    expect(results.filter((r) => r.kind === 'done')).toHaveLength(6);
    for (const subject of subjects) expect((await inA((tx) => getContract(tx, subject.id)))?.status).toBe('awaiting_landlord');
    const { rows } = await dbh.owner.query<{ attempts: number; status: string }>(
      `SELECT attempts, status FROM control.inbox_messages WHERE provider_task_ref = ANY($1)`,
      [refs],
    );
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.status === 'done' && r.attempts === 2)).toBe(true);
  });

  it('被別的交易鎖住的 inbox 列直接略過，不等待也不重複處理', async () => {
    const ref = `locked-${newUlid()}`;
    const signing = moduleWith();
    await signing.ingestWebhook(JSON.stringify({ taskRef: ref, email: 't@example.com' }), new Headers());
    const subject = await sentContract(ref);

    const holder = await dbh.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT id FROM control.inbox_messages WHERE provider_task_ref = $1 FOR UPDATE`, [ref]);

      const started = Date.now();
      const results = await signing.drainInbox(10);

      expect(results.filter((r) => r.kind === 'done')).toHaveLength(0);
      expect(results.every((r) => r.kind === 'not_claimed')).toBe(true);
      expect(Date.now() - started).toBeLessThan(3000);
      expect((await inA((tx) => getContract(tx, subject.id)))?.status).toBe('awaiting_tenant');
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect((await signing.drainInbox(10)).filter((r) => r.kind === 'done')).toHaveLength(1);
  });

  it('三個 drain-outbox 同時跑：每個撤回只呼叫服務商一次', async () => {
    voidOk = false;
    const refs = Array.from({ length: 4 }, (_, i) => `void-${newUlid()}-${i}`);
    const subjects = [];
    for (const ref of refs) {
      const subject = await sentContract(ref);
      subjects.push(subject);
      await expect(moduleWith().voidTask(subject)).rejects.toThrow();
    }
    voidOk = true;
    voidCalls.length = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const signing = moduleWith();

    const results = (await Promise.all([signing.drainOutbox(orgA, 10), signing.drainOutbox(orgA, 10), signing.drainOutbox(orgA, 10)])).flat();

    expect(results.filter((r) => r.kind === 'done')).toHaveLength(4);
    expect([...voidCalls].sort()).toEqual([...refs].sort());
    for (const subject of subjects) expect((await inA((tx) => getContract(tx, subject.id)))?.status).toBe('voided');
  });

  it('同一個計時器項目兩個掃描同時跑：效果只發生一次', async () => {
    const { runScanTimers } = await import('./scan-timers');
    const { createTimerRegistry } = await import('./timers/registry');
    let effects = 0;
    const registry = createTimerRegistry();
    registry.register({
      name: 'pg_probe',
      scope: 'global',
      scan: async () => [{ subjectId: 'PGS1', event: 'pg_probe_due', date: '2026-11-09' }],
      fire: async () => {
        await new Promise((r) => setTimeout(r, 50));
        effects++;
      },
    });
    const { useTxDriver } = await import('../pg/database');
    useTxDriver(pgDriver(dbh.pool));
    try {
      const runs = await Promise.all([1, 2, 3].map(() => runScanTimers(registry, { today: '2026-11-09', limit: 10 })));
      expect(effects).toBe(1);
      expect(runs.reduce((n, r) => n + r.fired, 0)).toBe(1);
    } finally {
      useTxDriver(undefined);
    }
  });
});
