import { createHash } from 'node:crypto';
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
import { INBOX_MAX_RETRIES, INBOX_STALE_MS, listDeadInbox } from './inbox';
import { createSigningModule } from './module';
import type { SignableDocument, Signer, SigningEventType, SigningProvider } from './provider';
import type { SigningSubscriber } from './subscriber';

// webhook 的 inbox（MIL-86，ADR-0020 決議 5、9）。走簽署模組介面，PGlite 上跑。
// inbox 的欄位是 AC 明列的約束（只存標準化事件與 body 雜湊），所以這份測試直接讀 control.inbox_messages。

let kit: RouteDb;
let dataDir: string;

beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());

beforeEach(async () => {
  await kit.reset();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signing-inbox-'));
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

const moduleWith = (provider: SigningProvider, subscriber: SigningSubscriber = createContractSubscriber()) =>
  createSigningModule({ provider, subscribers: { contract: subscriber }, files: createLocalFileStore(dataDir), db: dbFor(kit.orgA) });

// body 是 JSON：{ taskRef, email, type, ...其他欄位 }。其他欄位用來驗證 inbox 不存原始 body
function bodyOf(taskRef: string, email: string, type: SigningEventType = 'signed', extra: Record<string, unknown> = {}) {
  return JSON.stringify({ taskRef, email, type, ...extra });
}

const providerWith = (overrides: Partial<SigningProvider> = {}): SigningProvider => ({
  id: 'dottedsign',
  mode: 'live',
  unsupported: { simulate: 'live 模式下請走真實 webhook' },
  createTask: async () => ({ taskRef: crypto.randomUUID() }),
  getSignLink: async () => 'https://sign.example/abc',
  resend: async () => {},
  voidTask: async () => {},
  downloadFile: async (taskRef, kind) => new TextEncoder().encode(`${kind}-of-${taskRef}`),
  parseWebhook: (raw) => {
    if (raw === '') return { kind: 'ping' };
    const { taskRef, email, type } = JSON.parse(raw) as { taskRef: string; email?: string; type: SigningEventType };
    return { kind: 'event', taskRef, event: { type, email } };
  },
  ...overrides,
});

const FIELDS = {
  landlordName: '林房東',
  landlordEmail: 'landlord@example.com',
  tenantName: '王租客',
  tenantEmail: 'tenant@example.com',
} as ContractFields;

async function newDraft() {
  const id = newUlid();
  await inA((tx) =>
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

/** 送簽並讓服務商任務編號固定。 */
async function sendWithRef(taskRef: string) {
  const subject = await newDraft();
  const provider = providerWith({ createTask: async () => ({ taskRef }) });
  const signing = moduleWith(provider);
  await signing.send(subject, document, signers);
  return { subject, signing };
}

const statusOf = async (id: string) => (await inA((tx) => getContract(tx, id)))?.status;
const eventTypes = async (id: string) => (await inA((tx) => listContractEvents(tx, id))).map((e) => e.type);

interface InboxView {
  status: string;
  attempts: number;
  last_error: string | null;
  provider_task_ref: string;
  event_type: string;
}
const inboxRows = () =>
  withTx({ kind: 'control' }, async (tx) => {
    const { rows } = await tx.query<InboxView>(
      'SELECT status, attempts, last_error, provider_task_ref, event_type FROM control.inbox_messages ORDER BY id',
    );
    return rows;
  });

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('寫入 inbox 再處理一次', () => {
  it('驗簽後的事件先寫 inbox，同一個請求內處理完，inbox 列標為 done，回 200', async () => {
    const { subject, signing } = await sendWithRef('task-1');

    const ack = await signing.ingestWebhook(bodyOf('task-1', 'tenant@example.com'), new Headers());

    expect(ack).toEqual({ status: 200, body: { ok: true } });
    expect(await statusOf(subject.id)).toBe('awaiting_landlord');
    expect(await inboxRows()).toEqual([
      { status: 'done', attempts: 1, last_error: null, provider_task_ref: 'task-1', event_type: 'signed' },
    ]);
  });

  it('inbox 只存標準化的事件與 body 雜湊，整列轉成文字也找不到原始 body', async () => {
    const { signing } = await sendWithRef('task-2');
    const body = bodyOf('task-2', 'tenant@example.com', 'signed', { marker: 'RAW-BODY-MARKER-9f3a', nested: { x: 1 } });

    await signing.ingestWebhook(body, new Headers());

    const dump = await withTx({ kind: 'control' }, async (tx) => {
      const { rows } = await tx.query<{ j: string }>('SELECT row_to_json(m)::text AS j FROM control.inbox_messages m');
      return rows;
    });
    expect(dump).toHaveLength(1);
    expect(dump[0].j).not.toContain('RAW-BODY-MARKER-9f3a');
    expect(dump[0].j).not.toContain(body);
    expect(dump[0].j).toContain(sha256(body));
  });

  it('處理失敗（交易回滾）也回 200，事件留在 inbox 等排程重試', async () => {
    const { subject } = await sendWithRef('task-3');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const flaky: SigningSubscriber = {
      ...createContractSubscriber(),
      onOutcome: async () => {
        throw new Error('歷程寫入失敗');
      },
    };

    const ack = await moduleWith(providerWith(), flaky).ingestWebhook(bodyOf('task-3', 'tenant@example.com'), new Headers());

    expect(ack).toEqual({ status: 200, body: { ok: true, queued: true } });
    expect(await statusOf(subject.id)).toBe('awaiting_tenant');
    expect(await inboxRows()).toEqual([
      { status: 'pending', attempts: 1, last_error: '歷程寫入失敗', provider_task_ref: 'task-3', event_type: 'signed' },
    ]);
  });

  it('寫不進 inbox 時不回 2xx，讓服務商重送', async () => {
    await sendWithRef('task-4');
    const broken: SigningDb = {
      ...dbFor(kit.orgA),
      inControl: async () => {
        throw new Error('資料庫無法連線');
      },
    };
    const down = createSigningModule({
      provider: providerWith(),
      subscribers: { contract: createContractSubscriber() },
      files: createLocalFileStore(dataDir),
      db: broken,
    });

    await expect(down.ingestWebhook(bodyOf('task-4', 'tenant@example.com'), new Headers())).rejects.toThrow('資料庫無法連線');
  });

  it('簽章無效與 ping 不寫 inbox', async () => {
    const provider = providerWith({ parseWebhook: (raw) => (raw === '' ? { kind: 'ping' } : { kind: 'invalid', status: 401, reason: 'invalid signature' }) });
    const signing = moduleWith(provider);

    expect((await signing.ingestWebhook('', new Headers())).status).toBe(200);
    expect((await signing.ingestWebhook('x', new Headers())).status).toBe(401);
    expect(await inboxRows()).toEqual([]);
  });
});

describe('重複事件去重', () => {
  it('相同服務商與 body 的第二次：回 200 ignored，inbox 仍只有一列，合約只推進一次', async () => {
    const { subject, signing } = await sendWithRef('task-10');
    const body = bodyOf('task-10', 'tenant@example.com');

    await signing.ingestWebhook(body, new Headers());
    const second = await signing.ingestWebhook(body, new Headers());

    expect(second).toEqual({ status: 200, body: { ok: true, ignored: true } });
    expect(await inboxRows()).toHaveLength(1);
    expect(await eventTypes(subject.id)).toEqual(['sent', 'signer_signed']);
  });

  it('body 不同（簽署人不同）是不同的事件，各自處理', async () => {
    const { subject, signing } = await sendWithRef('task-11');

    await signing.ingestWebhook(bodyOf('task-11', 'tenant@example.com'), new Headers());
    await signing.ingestWebhook(bodyOf('task-11', 'landlord@example.com'), new Headers());

    expect(await inboxRows()).toHaveLength(2);
    expect((await signing.getProgress(subject))?.signers.map((x) => x.status)).toEqual(['signed', 'signed']);
  });

  it('同一個事件同時送來兩次：inbox 一列，只處理一次', async () => {
    const { subject, signing } = await sendWithRef('task-12');
    const body = bodyOf('task-12', 'tenant@example.com');

    const acks = await Promise.all([signing.ingestWebhook(body, new Headers()), signing.ingestWebhook(body, new Headers())]);

    expect(acks.map((a) => a.status)).toEqual([200, 200]);
    expect(await inboxRows()).toHaveLength(1);
    expect(await eventTypes(subject.id)).toEqual(['sent', 'signer_signed']);
  });
});

describe('ADR-0010 決議 9：email 守門', () => {
  it('已簽事件的 email 不是當前簽署人：事件被忽略，inbox 標為 ignored，合約不動', async () => {
    const { subject, signing } = await sendWithRef('task-20');

    const ack = await signing.ingestWebhook(bodyOf('task-20', 'landlord@example.com'), new Headers());

    expect(ack).toEqual({ status: 200, body: { ok: true, ignored: true } });
    expect(await statusOf(subject.id)).toBe('awaiting_tenant');
    expect((await inboxRows())[0]).toMatchObject({ status: 'ignored', attempts: 1 });
  });
});

describe('路由列還不存在', () => {
  it('留在 inbox，不丟棄。路由列出現後 drainInbox 補處理', async () => {
    const early = providerWith();
    const signing = moduleWith(early);

    // 建立任務的交易還沒提交，webhook 先到
    const ack = await signing.ingestWebhook(bodyOf('task-30', 'tenant@example.com'), new Headers());
    expect(ack).toEqual({ status: 200, body: { ok: true, queued: true } });
    expect(await inboxRows()).toEqual([
      expect.objectContaining({ status: 'pending', attempts: 1, provider_task_ref: 'task-30' }),
    ]);

    // 任務建立完成
    const subject = await newDraft();
    await moduleWith(providerWith({ createTask: async () => ({ taskRef: 'task-30' }) })).send(subject, document, signers);
    expect(await statusOf(subject.id)).toBe('awaiting_tenant');

    const results = await signing.drainInbox(10);

    expect(results).toEqual([{ kind: 'done' }]);
    expect(await statusOf(subject.id)).toBe('awaiting_landlord');
    expect(await inboxRows()).toEqual([expect.objectContaining({ status: 'done', attempts: 2 })]);
  });

  it('處理時依路由列取得組織：請求脈絡指向別的組織也不影響', async () => {
    const { subject } = await sendWithRef('task-31');
    const otherOrg = createSigningModule({
      provider: providerWith(),
      subscribers: { contract: createContractSubscriber() },
      files: createLocalFileStore(dataDir),
      db: dbFor(kit.orgB),
    });

    await otherOrg.ingestWebhook(bodyOf('task-31', 'tenant@example.com'), new Headers());

    expect(await statusOf(subject.id)).toBe('awaiting_landlord');
  });

  it('一直找不到路由列：第 6 次處理失敗後轉人工處理清單（dead），之後不再重試', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const signing = moduleWith(providerWith());
    await signing.ingestWebhook(bodyOf('ghost', 'tenant@example.com'), new Headers());

    for (let i = 0; i < INBOX_MAX_RETRIES; i++) {
      expect((await inboxRows())[0].status).toBe('pending');
      await signing.drainInbox(10);
    }

    expect(await inboxRows()).toEqual([expect.objectContaining({ status: 'dead', attempts: INBOX_MAX_RETRIES + 1 })]);
    expect(await signing.drainInbox(10)).toEqual([]);
    const dead = await withTx({ kind: 'control' }, (tx) => listDeadInbox(tx));
    expect(dead.map((r) => r.taskRef)).toEqual(['ghost']);
  });
});

describe('同一個服務商任務的事件依序處理', () => {
  it('較早的事件還在 inbox 等待時，較晚的事件不搶先處理，之後依序補上', async () => {
    const signing = moduleWith(providerWith());
    // 第一個事件先到，路由列還沒有，留在 inbox
    await signing.ingestWebhook(bodyOf('task-40', 'tenant@example.com'), new Headers());
    const subject = await newDraft();
    await moduleWith(providerWith({ createTask: async () => ({ taskRef: 'task-40' }) })).send(subject, document, signers);

    // 路由列已存在，第二個事件到了。第一個還沒處理，所以第二個等
    const ack = await signing.ingestWebhook(bodyOf('task-40', 'landlord@example.com'), new Headers());

    expect(ack).toEqual({ status: 200, body: { ok: true, queued: true } });
    expect(await statusOf(subject.id)).toBe('awaiting_tenant');
    // 等待不算一次處理
    expect((await inboxRows()).map((r) => [r.status, r.attempts])).toEqual([
      ['pending', 1],
      ['pending', 0],
    ]);

    await signing.drainInbox(10);

    expect((await signing.getProgress(subject))?.signers.map((x) => x.status)).toEqual(['signed', 'signed']);
    expect((await inboxRows()).map((r) => r.status)).toEqual(['done', 'done']);
  });
});

describe('drainInbox：每次的量、隔離與中斷', () => {
  it('每次最多處理 limit 筆，剩下的留給下一次', async () => {
    const signing = moduleWith(providerWith());
    for (const ref of ['a', 'b', 'c']) await signing.ingestWebhook(bodyOf(ref, 'x@example.com'), new Headers());
    vi.spyOn(console, 'info').mockImplementation(() => {});

    expect(await signing.drainInbox(2)).toHaveLength(2);
    expect((await inboxRows()).map((r) => r.attempts)).toEqual([2, 2, 1]);
  });

  it('一筆處理失敗不影響其他筆', async () => {
    const good = await sendWithRef('task-50');
    const bad = await sendWithRef('task-51');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // 先讓兩個事件都留在 inbox：用一個一律失敗的訂閱者收下
    const alwaysFail: SigningSubscriber = {
      ...createContractSubscriber(),
      onOutcome: async () => {
        throw new Error('暫時性失敗');
      },
    };
    const failing = moduleWith(providerWith(), alwaysFail);
    await failing.ingestWebhook(bodyOf('task-51', 'tenant@example.com'), new Headers());
    await failing.ingestWebhook(bodyOf('task-50', 'tenant@example.com'), new Headers());
    expect((await inboxRows()).map((r) => r.status)).toEqual(['pending', 'pending']);

    // 排程時只有 bad 的合約出錯
    const selective: SigningSubscriber = {
      ...createContractSubscriber(),
      onOutcome: async (tx, subject, outcome) => {
        if (subject.id === bad.subject.id) throw new Error('只有這份合約出錯');
        return createContractSubscriber().onOutcome(tx, subject, outcome);
      },
    };
    const results = await moduleWith(providerWith(), selective).drainInbox(10);

    expect(results.map((r) => r.kind).sort()).toEqual(['done', 'failed']);
    expect(await statusOf(good.subject.id)).toBe('awaiting_landlord');
    expect(await statusOf(bad.subject.id)).toBe('awaiting_tenant');
  });

  it('處理到一半中斷（processing 超過期限）視為失敗，排程重新處理', async () => {
    const { subject, signing } = await sendWithRef('task-60');
    await withTx({ kind: 'control' }, (tx) =>
      tx.query(
        `INSERT INTO control.inbox_messages (id, provider, body_sha256, provider_task_ref, event_type, event_email, status, attempts, updated_at)
         VALUES ($1, 'dottedsign', $2, 'task-60', 'signed', 'tenant@example.com', 'processing', 1,
                 now() - ($3::int * interval '1 millisecond') - interval '1 second')`,
        [newUlid(), sha256('stale'), INBOX_STALE_MS],
      ),
    );

    const results = await signing.drainInbox(10);

    expect(results).toEqual([{ kind: 'done' }]);
    expect(await statusOf(subject.id)).toBe('awaiting_landlord');
  });

  it('仍在處理中（沒超過期限）的列不被另一個排程搶走', async () => {
    const signing = moduleWith(providerWith());
    await withTx({ kind: 'control' }, (tx) =>
      tx.query(
        `INSERT INTO control.inbox_messages (id, provider, body_sha256, provider_task_ref, event_type, status, attempts, updated_at)
         VALUES ($1, 'dottedsign', $2, 'task-61', 'signed', 'processing', 1, now())`,
        [newUlid(), sha256('busy')],
      ),
    );

    expect(await signing.drainInbox(10)).toEqual([]);
    expect((await inboxRows())[0].status).toBe('processing');
  });
});

describe('完成事件', () => {
  it('全員完成經 inbox 處理後，提交後保存文件', async () => {
    const { subject, signing } = await sendWithRef('task-70');
    await signing.ingestWebhook(bodyOf('task-70', 'tenant@example.com'), new Headers());
    await signing.ingestWebhook(bodyOf('task-70', 'landlord@example.com'), new Headers());

    await signing.ingestWebhook(bodyOf('task-70', '', 'completed'), new Headers());

    expect(await statusOf(subject.id)).toBe('completed');
    expect((await signing.listFiles(subject)).map((f) => f.status).sort()).toEqual(['saved', 'saved']);
  });
});
