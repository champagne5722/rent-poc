import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalFileStore } from '../file-store/local-file-store';
import { createContractSubscriber } from '../contract-signing';
import { getContract, listContractEvents } from '../contracts';
import { withTx } from '../pg/database';
import { setupRouteDb, type RouteDb } from '../pg/route-test-kit';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import type { ContractFields } from '../types';
import { type SigningDb } from './db';
import { createMockProvider } from './mock-adapter';
import { createSigningModule } from './module';
import { listDeadOutbox, OUTBOX_MAX_RETRIES, OUTBOX_STALE_MS, recoverStaleOutbox } from './outbox';
import type { SignableDocument, Signer, SigningProvider } from './provider';

// outbox、路由列與同交易（MIL-85，ADR-0020）。走簽署模組介面，Mock adapter 或替身 adapter，PGlite 上跑。

let kit: RouteDb;
let dataDir: string;

beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());

beforeEach(async () => {
  await kit.reset();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signing-outbox-'));
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const inOrg = <T,>(orgId: string, fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId }, fn);
const inA = <T,>(fn: (tx: OrgTx) => Promise<T>) => inOrg(kit.orgA, fn);

const dbFor = (orgId: string): SigningDb => ({
  requestOrg: async () => ({ kind: 'org', orgId }),
  inOrg: (ctx, fn) => withTx(ctx, fn),
  inControl: (fn) => withTx({ kind: 'control' }, fn),
});

const moduleWith = (provider: SigningProvider = createMockProvider(), orgId = kit.orgA) =>
  createSigningModule({
    provider,
    subscribers: { contract: createContractSubscriber() },
    files: createLocalFileStore(dataDir),
    db: dbFor(orgId),
  });

const liveProvider = (overrides: Partial<SigningProvider> = {}): SigningProvider => ({
  id: 'dottedsign',
  mode: 'live',
  unsupported: { simulate: 'live 模式下請走真實 webhook' },
  createTask: async () => ({ taskRef: crypto.randomUUID() }),
  getSignLink: async () => 'https://sign.example/abc',
  resend: async () => {},
  voidTask: async () => {},
  downloadFile: async (taskRef, kind) => new TextEncoder().encode(`${kind}-of-${taskRef}`),
  parseWebhook: () => ({ kind: 'ignored' }),
  ...overrides,
});

const FIELDS = {
  landlordName: '林房東',
  landlordEmail: 'landlord@example.com',
  tenantName: '王租客',
  tenantEmail: 'tenant@example.com',
} as ContractFields;

async function newDraft(orgId = kit.orgA) {
  const id = newUlid();
  await inOrg(orgId, (tx) =>
    tx.query(`INSERT INTO org.contracts (id, org_id, fields) VALUES ($1, current_setting('app.org_id', true), $2::jsonb)`, [
      id,
      JSON.stringify(FIELDS),
    ]),
  );
  return { type: 'contract', id } as const;
}

const document: SignableDocument = {
  fileName: '租賃合約-測試物件',
  pdf: new Uint8Array([37, 80, 68, 70]),
  pageSize: { width: 595.28, height: 841.89 },
};
const signers: Signer[] = [
  { role: 'party_b', name: '王租客', email: 'tenant@example.com', signatureFields: [] },
  { role: 'party_a', name: '林房東', email: 'landlord@example.com', signatureFields: [] },
];

const statusOf = async (id: string) => (await inA((tx) => getContract(tx, id)))?.status;
const eventTypes = async (id: string) => (await inA((tx) => listContractEvents(tx, id))).map((e) => e.type);

interface OutboxView {
  action: string;
  status: string;
  attempts: number;
  last_error: string | null;
  provider_task_ref: string | null;
}
const outboxRows = (orgId = kit.orgA) =>
  inOrg(orgId, async (tx) => {
    const { rows } = await tx.query<OutboxView>(
      'SELECT action, status, attempts, last_error, provider_task_ref FROM org.outbox ORDER BY id',
    );
    return rows;
  });
const routeRows = () =>
  withTx({ kind: 'control' }, async (tx) => {
    const { rows } = await tx.query<{ provider: string; provider_task_ref: string; org_id: string }>(
      'SELECT provider, provider_task_ref, org_id FROM control.sign_task_routes ORDER BY created_at',
    );
    return rows;
  });

const failContractEventWrites = () =>
  kit.asOwner((pg) =>
    pg.exec(`CREATE FUNCTION org.fail_contract_events() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '歷程寫入失敗'; END $$;
             CREATE TRIGGER fail_contract_events BEFORE INSERT ON org.contract_events FOR EACH ROW EXECUTE FUNCTION org.fail_contract_events();`),
  );

describe('送簽：outbox 與路由列', () => {
  it('成功：outbox 完成並記服務商任務編號，路由列指向送簽的組織', async () => {
    const subject = await newDraft();
    const provider = liveProvider({ createTask: async () => ({ taskRef: 'task-100' }) });
    await moduleWith(provider).send(subject, document, signers);

    expect(await outboxRows()).toEqual([
      { action: 'create_sign_task', status: 'done', attempts: 1, last_error: null, provider_task_ref: 'task-100' },
    ]);
    expect(await routeRows()).toEqual([{ provider: 'dottedsign', provider_task_ref: 'task-100', org_id: kit.orgA }]);
  });

  it('服務商建立失敗：outbox 轉 failed 並留原因，不自動重試，合約維持草稿、沒有路由列', async () => {
    const subject = await newDraft();
    const createTask = vi.fn(async () => {
      throw new Error('點點簽 API 失敗（500）');
    });
    const signing = moduleWith(liveProvider({ createTask }));

    await expect(signing.send(subject, document, signers)).rejects.toThrow('點點簽 API 失敗（500）');

    expect(await statusOf(subject.id)).toBe('draft');
    expect(await outboxRows()).toEqual([
      { action: 'create_sign_task', status: 'failed', attempts: 1, last_error: '點點簽 API 失敗（500）', provider_task_ref: null },
    ]);
    expect(await routeRows()).toEqual([]);
    // 排程不會撿到這一列
    expect(await signing.drainOutbox(kit.orgA, 10)).toEqual([]);
    expect(createTask).toHaveBeenCalledTimes(1);
  });

  it('失敗後使用者能重新送簽', async () => {
    const subject = await newDraft();
    let calls = 0;
    const signing = moduleWith(
      liveProvider({
        createTask: async () => {
          if (++calls === 1) throw new Error('點點簽 API 失敗（500）');
          return { taskRef: 'task-200' };
        },
      }),
    );
    await expect(signing.send(subject, document, signers)).rejects.toThrow();

    await signing.send(subject, document, signers);

    expect(await statusOf(subject.id)).toBe('awaiting_tenant');
    expect((await outboxRows()).map((r) => r.status)).toEqual(['failed', 'done']);
  });

  it('寫入平台失敗（歷程寫不進去）：整筆回滾，服務商任務編號留在 outbox 供人工清理', async () => {
    const subject = await newDraft();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await failContractEventWrites();

    await expect(
      moduleWith(liveProvider({ createTask: async () => ({ taskRef: 'orphan-1' }) })).send(subject, document, signers),
    ).rejects.toThrow('歷程寫入失敗');

    expect(await statusOf(subject.id)).toBe('draft');
    expect(await routeRows()).toEqual([]);
    const [row] = await outboxRows();
    expect(row).toMatchObject({ status: 'failed', provider_task_ref: 'orphan-1' });
    expect(row.last_error).toContain('歷程寫入失敗');
  });

  it('alsoInTx 與簽署任務同一個交易：它失敗時簽署任務、路由列、合約狀態都回滾', async () => {
    const subject = await newDraft();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const signing = moduleWith(liveProvider({ createTask: async () => ({ taskRef: 'task-300' }) }));

    await expect(
      signing.send(subject, document, signers, {
        alsoInTx: async () => {
          throw new Error('快照寫入失敗');
        },
      }),
    ).rejects.toThrow('快照寫入失敗');

    expect(await statusOf(subject.id)).toBe('draft');
    expect(await signing.getProgress(subject)).toBeNull();
    expect(await routeRows()).toEqual([]);
  });

  it('同時兩個送簽：只有一個建立服務商任務，另一個 409', async () => {
    const subject = await newDraft();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const createTask = vi.fn(async () => {
      await gate;
      return { taskRef: 'task-400' };
    });
    const signing = moduleWith(liveProvider({ createTask }));

    const first = signing.send(subject, document, signers);
    // 等第一個送簽的 outbox 列寫入（它卡在 createTask）
    await vi.waitFor(async () => expect(await outboxRows()).toHaveLength(1));
    await expect(signing.send(subject, document, signers)).rejects.toMatchObject({ status: 409, message: '送簽處理中，請稍後再試' });
    release();
    await first;

    expect(createTask).toHaveBeenCalledTimes(1);
    expect(await statusOf(subject.id)).toBe('awaiting_tenant');
  });

  it('派送中斷（程序終止）留下的 sending 列超過期限後視為失敗，不再擋住重新送簽', async () => {
    const subject = await newDraft();
    await inA((tx) =>
      tx.query(
        `INSERT INTO org.outbox (id, org_id, action, subject_type, subject_id, status, attempts, updated_at)
         VALUES ($1, current_setting('app.org_id', true), 'create_sign_task', 'contract', $2, 'sending', 1,
                 now() - ($3::int * interval '1 millisecond') - interval '1 second')`,
        [newUlid(), subject.id, OUTBOX_STALE_MS],
      ),
    );

    await moduleWith().send(subject, document, signers);

    expect((await outboxRows()).map((r) => r.status)).toEqual(['failed', 'done']);
    expect((await outboxRows())[0].last_error).toContain('結果不明');
  });

  it('服務商任務編號已被別的組織使用：後送簽的組織整筆回滾，合約維持草稿', async () => {
    const mine = await newDraft();
    const theirs = await newDraft(kit.orgB);
    const provider = liveProvider({ createTask: async () => ({ taskRef: 'shared-ref' }) });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await moduleWith(provider, kit.orgA).send(mine, document, signers);

    await expect(moduleWith(provider, kit.orgB).send(theirs, document, signers)).rejects.toMatchObject({ status: 409 });

    expect(await inOrg(kit.orgB, (tx) => getContract(tx, theirs.id)).then((c) => c?.status)).toBe('draft');
    expect(await routeRows()).toEqual([{ provider: 'dottedsign', provider_task_ref: 'shared-ref', org_id: kit.orgA }]);
  });
});

describe('webhook：由路由列查出組織', () => {
  const eventBody = (taskRef: string, email: string) => JSON.stringify({ taskRef, email });
  const webhookProvider = (): SigningProvider =>
    liveProvider({
      createTask: async () => ({ taskRef: crypto.randomUUID() }),
      parseWebhook: (raw) => {
        const { taskRef, email } = JSON.parse(raw) as { taskRef: string; email: string };
        return { kind: 'event', taskRef, event: { type: 'signed', email } };
      },
    });

  it('請求脈絡是別的組織（或沒有請求）也能處理：組織來自路由列，不是預設組織', async () => {
    const subject = await newDraft(kit.orgA);
    const provider = liveProvider({
      createTask: async () => ({ taskRef: 'task-500' }),
      parseWebhook: webhookProvider().parseWebhook,
    });
    await moduleWith(provider, kit.orgA).send(subject, document, signers);

    // webhook 進來時，模組的請求脈絡指向 B 組織
    const ack = await moduleWith(provider, kit.orgB).ingestWebhook(eventBody('task-500', 'tenant@example.com'), new Headers());

    expect(ack).toEqual({ status: 200, body: { ok: true } });
    expect(await statusOf(subject.id)).toBe('awaiting_landlord');
    expect(await eventTypes(subject.id)).toEqual(['sent', 'signer_signed']);
  });

  it('webhook 不經過 requestOrg：脈絡取不到時仍能處理', async () => {
    const subject = await newDraft();
    const provider = liveProvider({
      createTask: async () => ({ taskRef: 'task-600' }),
      parseWebhook: webhookProvider().parseWebhook,
    });
    await moduleWith(provider).send(subject, document, signers);
    const noRequest: SigningDb = {
      ...dbFor(kit.orgA),
      requestOrg: async () => {
        throw new Error('webhook 沒有請求脈絡');
      },
    };
    const webhookOnly = createSigningModule({
      provider,
      subscribers: { contract: createContractSubscriber() },
      files: createLocalFileStore(dataDir),
      db: noRequest,
    });

    const ack = await webhookOnly.ingestWebhook(eventBody('task-600', 'tenant@example.com'), new Headers());
    expect(ack.status).toBe(200);
    expect(await statusOf(subject.id)).toBe('awaiting_landlord');
  });

  it('對不到路由列的事件回 2xx，留在 inbox 等重試（MIL-86），不丟棄', async () => {
    const ack = await moduleWith(webhookProvider()).ingestWebhook(eventBody('nobody', 'a@example.com'), new Headers());
    expect(ack).toEqual({ status: 200, body: { ok: true, queued: true } });
  });

  it('同一個事件同時送來兩次：只套用一次，歷程只多一筆', async () => {
    const subject = await newDraft();
    const provider = liveProvider({
      createTask: async () => ({ taskRef: 'task-700' }),
      parseWebhook: webhookProvider().parseWebhook,
    });
    const signing = moduleWith(provider);
    await signing.send(subject, document, signers);

    const body = eventBody('task-700', 'tenant@example.com');
    const acks = await Promise.all([signing.ingestWebhook(body, new Headers()), signing.ingestWebhook(body, new Headers())]);

    expect(acks.map((a) => a.status)).toEqual([200, 200]);
    expect(acks.filter((a) => 'ignored' in a.body)).toHaveLength(1);
    expect(await eventTypes(subject.id)).toEqual(['sent', 'signer_signed']);
    expect((await signing.getProgress(subject))?.signers.map((s) => s.status)).toEqual(['signed', 'pending']);
  });
});

describe('撤回與重寄：失敗留待重試', () => {
  async function sentOver(provider: SigningProvider) {
    const subject = await newDraft();
    const signing = moduleWith(provider);
    await signing.send(subject, document, signers);
    return { subject, signing };
  }

  it('撤回成功：outbox 完成，進度、合約狀態、歷程一起寫入', async () => {
    const { subject, signing } = await sentOver(liveProvider());
    await signing.voidTask(subject);

    expect(await statusOf(subject.id)).toBe('voided');
    expect((await signing.getProgress(subject))?.status).toBe('voided');
    expect((await outboxRows()).map((r) => [r.action, r.status])).toEqual([
      ['create_sign_task', 'done'],
      ['void_sign_task', 'done'],
    ]);
  });

  it('撤回失敗：回 502 並寫明已排入重試，合約維持簽署中，outbox 留 pending', async () => {
    const voidTask = vi.fn(async () => {
      throw new Error('點點簽 API 失敗（503）');
    });
    const { subject, signing } = await sentOver(liveProvider({ voidTask }));

    await expect(signing.voidTask(subject)).rejects.toMatchObject({
      status: 502,
      message: '撤回合約失敗：點點簽 API 失敗（503）。已排入重試',
    });

    expect(await statusOf(subject.id)).toBe('awaiting_tenant');
    expect((await outboxRows()).at(-1)).toMatchObject({
      action: 'void_sign_task',
      status: 'pending',
      attempts: 1,
      last_error: '點點簽 API 失敗（503）',
    });
  });

  it('排程重試成功：撤回生效，outbox 完成', async () => {
    let fail = true;
    const voidTask = vi.fn(async () => {
      if (fail) throw new Error('點點簽 API 失敗（503）');
    });
    const { subject, signing } = await sentOver(liveProvider({ voidTask }));
    await expect(signing.voidTask(subject)).rejects.toThrow();
    fail = false;

    expect(await signing.drainOutbox(kit.orgA, 10)).toEqual([{ kind: 'done' }]);

    expect(await statusOf(subject.id)).toBe('voided');
    expect((await outboxRows()).at(-1)).toMatchObject({ status: 'done', attempts: 2 });
  });

  it(`重試上限 ${OUTBOX_MAX_RETRIES} 次：第一次之外再失敗 ${OUTBOX_MAX_RETRIES} 次後轉 dead，進人工處理清單，不再被撿起`, async () => {
    const voidTask = vi.fn(async () => {
      throw new Error('點點簽 API 失敗（503）');
    });
    const { subject, signing } = await sentOver(liveProvider({ voidTask }));
    await expect(signing.voidTask(subject)).rejects.toThrow();

    for (let retry = 1; retry <= OUTBOX_MAX_RETRIES; retry++) {
      expect((await outboxRows()).at(-1)?.status).toBe('pending');
      const [result] = await signing.drainOutbox(kit.orgA, 10);
      expect(result).toMatchObject({ kind: 'failed', status: retry === OUTBOX_MAX_RETRIES ? 'dead' : 'pending' });
    }

    expect(voidTask).toHaveBeenCalledTimes(OUTBOX_MAX_RETRIES + 1);
    expect((await outboxRows()).at(-1)).toMatchObject({ status: 'dead', attempts: OUTBOX_MAX_RETRIES + 1 });
    expect(await inA((tx) => listDeadOutbox(tx))).toHaveLength(1);
    expect(await signing.drainOutbox(kit.orgA, 10)).toEqual([]);
    expect(await statusOf(subject.id)).toBe('awaiting_tenant');
  });

  it('用戶在重試等待期間再按撤回：直接派送同一列，不另排', async () => {
    let fail = true;
    const { subject, signing } = await sentOver(
      liveProvider({
        voidTask: async () => {
          if (fail) throw new Error('點點簽 API 失敗（503）');
        },
      }),
    );
    await expect(signing.voidTask(subject)).rejects.toThrow();
    fail = false;

    await signing.voidTask(subject);

    expect(await statusOf(subject.id)).toBe('voided');
    expect((await outboxRows()).filter((r) => r.action === 'void_sign_task')).toHaveLength(1);
  });

  it('排程撿到時簽署任務已經完成：略過，合約維持已完成', async () => {
    let fail = true;
    const provider = liveProvider({
      voidTask: async () => {
        if (fail) throw new Error('點點簽 API 失敗（503）');
      },
    });
    const { subject, signing } = await sentOver(provider);
    await expect(signing.voidTask(subject)).rejects.toThrow();
    await inA((tx) => tx.query(`UPDATE org.sign_tasks SET status = 'completed' WHERE subject_id = $1`, [subject.id]));
    fail = false;

    expect(await signing.drainOutbox(kit.orgA, 10)).toEqual([{ kind: 'skipped', reason: '簽署任務已不在簽署中' }]);

    expect((await outboxRows()).at(-1)?.status).toBe('skipped');
  });

  it('呼叫服務商期間簽署任務被標為完成：撤回不生效並回 409（voidTask 競態，MIL-56 筆記）', async () => {
    const subjectRef: { id?: string } = {};
    const provider = liveProvider({
      voidTask: async () => {
        // 服務商回應之前，全員完成的事件先寫入
        await inA((tx) =>
          tx.query(`UPDATE org.sign_tasks SET status = 'completed' WHERE subject_id = $1`, [subjectRef.id]),
        );
      },
    });
    const { subject, signing } = await sentOver(provider);
    subjectRef.id = subject.id;

    await expect(signing.voidTask(subject)).rejects.toMatchObject({ status: 409, message: '僅簽署中的合約可撤回' });

    expect(await statusOf(subject.id)).toBe('awaiting_tenant');
    expect((await outboxRows()).at(-1)?.status).toBe('skipped');
  });

  it('服務商的 voided 事件比派送結果先到：撤回算完成，不回 409', async () => {
    const subjectRef: { id?: string } = {};
    const provider = liveProvider({
      voidTask: async () => {
        // 服務商撤回後，voided webhook 先寫入進度與合約
        await moduleWith(
          liveProvider({ parseWebhook: () => ({ kind: 'event', taskRef: 'void-first', event: { type: 'voided' } }) }),
        ).ingestWebhook('{}', new Headers());
      },
      createTask: async () => ({ taskRef: 'void-first' }),
    });
    const { subject, signing } = await sentOver(provider);
    subjectRef.id = subject.id;

    await expect(signing.voidTask(subject)).resolves.toBeUndefined();

    expect(await statusOf(subject.id)).toBe('voided');
    expect(await eventTypes(subject.id)).toEqual(['sent', 'voided']);
    expect((await outboxRows()).at(-1)).toMatchObject({ action: 'void_sign_task', status: 'done' });
  });

  it('撤回自己清掉同一個簽署標的停太久的 sending 列，不必等排程', async () => {
    const { subject, signing } = await sentOver(liveProvider());
    await inA((tx) =>
      tx.query(
        `INSERT INTO org.outbox (id, org_id, action, subject_type, subject_id, status, attempts, updated_at)
         VALUES ($1, current_setting('app.org_id', true), 'void_sign_task', 'contract', $2, 'sending', 1,
                 now() - ($3::int * interval '1 millisecond') - interval '1 second')`,
        [newUlid(), subject.id, OUTBOX_STALE_MS],
      ),
    );

    await signing.voidTask(subject);

    expect(await statusOf(subject.id)).toBe('voided');
  });

  it('服務商撤回成功但寫回平台失敗：列轉回等待重試，不卡在 sending', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { subject, signing } = await sentOver(liveProvider());
    await failContractEventWrites();

    await expect(signing.voidTask(subject)).rejects.toThrow('歷程寫入失敗');

    expect((await outboxRows()).at(-1)).toMatchObject({ action: 'void_sign_task', status: 'pending', attempts: 1 });
    expect(await statusOf(subject.id)).toBe('awaiting_tenant');
  });

  it('重寄失敗：回 502 並寫明已排入重試，outbox 留 pending；重試成功後完成', async () => {
    let fail = true;
    const resend = vi.fn(async () => {
      if (fail) throw new Error('點點簽 API 失敗（503）');
    });
    const { subject, signing } = await sentOver(liveProvider({ resend }));

    await expect(signing.resend(subject)).rejects.toMatchObject({
      status: 502,
      message: '重寄合約失敗：點點簽 API 失敗（503）。已排入重試',
    });
    expect((await outboxRows()).at(-1)).toMatchObject({ action: 'resend_sign_task', status: 'pending' });

    fail = false;
    expect(await signing.drainOutbox(kit.orgA, 10)).toEqual([{ kind: 'done' }]);
    expect(resend).toHaveBeenCalledTimes(2);
  });

  it('重試用完後的撤回再按一次：回 502 並寫明需要人工處理', async () => {
    const { subject, signing } = await sentOver(
      liveProvider({
        voidTask: async () => {
          throw new Error('點點簽 API 失敗（503）');
        },
      }),
    );
    await expect(signing.voidTask(subject)).rejects.toThrow();
    for (let i = 0; i < OUTBOX_MAX_RETRIES - 1; i++) await signing.drainOutbox(kit.orgA, 10);

    await expect(signing.voidTask(subject)).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining('重試次數已用完，需要人工處理'),
    });
  });

  it('派送中斷的撤回列（sending 太久）由排程轉回 pending 再重試', async () => {
    const { subject, signing } = await sentOver(liveProvider());
    await inA(async (tx) => {
      await tx.query(
        `INSERT INTO org.outbox (id, org_id, action, subject_type, subject_id, status, attempts, updated_at)
         VALUES ($1, current_setting('app.org_id', true), 'void_sign_task', 'contract', $2, 'sending', 1,
                 now() - ($3::int * interval '1 millisecond') - interval '1 second')`,
        [newUlid(), subject.id, OUTBOX_STALE_MS],
      );
    });

    expect(await signing.drainOutbox(kit.orgA, 10)).toEqual([{ kind: 'done' }]);

    expect(await statusOf(subject.id)).toBe('voided');
  });
});

describe('組織隔離', () => {
  it('B 組織的脈絡讀不到 A 組織的簽署任務、outbox，也撤回不了', async () => {
    const subject = await newDraft(kit.orgA);
    await moduleWith(liveProvider(), kit.orgA).send(subject, document, signers);
    const asB = moduleWith(liveProvider(), kit.orgB);

    expect(await asB.getProgress(subject)).toBeNull();
    expect(await outboxRows(kit.orgB)).toEqual([]);
    await expect(asB.voidTask(subject)).rejects.toMatchObject({ status: 404, message: '合約不存在' });
    expect(await statusOf(subject.id)).toBe('awaiting_tenant');
  });

  it('recoverStaleOutbox 只動自己組織的列', async () => {
    const a = await newDraft(kit.orgA);
    await inA((tx) =>
      tx.query(
        `INSERT INTO org.outbox (id, org_id, action, subject_type, subject_id, status, attempts, updated_at)
         VALUES ($1, current_setting('app.org_id', true), 'create_sign_task', 'contract', $2, 'sending', 1, now() - interval '1 day')`,
        [newUlid(), a.id],
      ),
    );
    expect(await inOrg(kit.orgB, (tx) => recoverStaleOutbox(tx))).toBe(0);
    expect(await inA((tx) => recoverStaleOutbox(tx))).toBe(1);
  });
});
