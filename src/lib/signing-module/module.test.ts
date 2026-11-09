import nodeCrypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalFileStore } from '../file-store/local-file-store';
import { createContractSubscriber } from '../contract-signing';
import { getContract, listContractEvents } from '../contracts';
import { withTx } from '../pg/database';
import { newUlid } from '../pg/ulid';
import { setupRouteDb, type RouteDb } from '../pg/route-test-kit';
import type { OrgTx } from '../pg/with-tx';
import type { ContractFields, ContractStatus } from '../types';
import { createDottedSignProvider } from './dottedsign-adapter';
import { createMockProvider } from './mock-adapter';
import { createSigningModule, signingErrorResponse, SigningRefusal } from './module';
import { ulidOf } from '../test-ids';
import type { SignableDocument, Signer, SigningProvider } from './provider';
import { insertSignTask, type SignerStatus, type SignTaskStatus } from './sign-task-store';
import type { SigningDb } from './db';
import type { SigningSubscriber } from './subscriber';

// 合約、合約歷程、簽署任務與簽署人都在 PostgreSQL（PGlite，app_rw，MIL-85）。
// 簽署進度、合約狀態與歷程在同一個交易：任一步失敗整筆回滾，見 module.ts 的 applyEventTx。

let kit: RouteDb;
// 文件本體寫在暫存目錄，不碰 data/
let dataDir: string;

beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());

beforeEach(async () => {
  await kit.reset();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signing-module-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const inA = <T,>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: kit.orgA }, fn);

const FIELDS = {
  landlordName: '林房東',
  landlordEmail: 'landlord@example.com',
  tenantName: '王租客',
  tenantEmail: 'tenant@example.com',
} as ContractFields;

// 簽署任務在各合約狀態下的進度：等同升級前就在這個狀態的合約。順序是乙方先、甲方後。
const PROGRESS_OF: Partial<Record<ContractStatus, [SignTaskStatus, SignerStatus, SignerStatus]>> = {
  awaiting_tenant: ['in_progress', 'pending', 'pending'],
  awaiting_landlord: ['in_progress', 'signed', 'pending'],
  completed: ['completed', 'signed', 'signed'],
  declined: ['declined', 'declined', 'pending'],
  voided: ['voided', 'pending', 'pending'],
};

/** 建一份指定狀態的合約。帶 taskRef 時一併建立簽署任務。 */
async function seed(status: ContractStatus, taskRef: string | null = null) {
  // 直接寫合約列，不記「建立」事件：這些測試只看簽署流程產生的歷程
  const id = newUlid();
  await inA((tx) =>
    tx.query(
      `INSERT INTO org.contracts (id, org_id, status, fields) VALUES ($1, current_setting('app.org_id', true), $2, $3::jsonb)`,
      [id, status, JSON.stringify(FIELDS)],
    ),
  );
  const subject = { type: 'contract', id } as const;
  const progress = taskRef !== null ? PROGRESS_OF[status] : undefined;
  if (taskRef !== null && progress) {
    await inA((tx) =>
      insertSignTask(tx, {
        provider: taskRef.startsWith('mock-') ? 'mock' : 'dottedsign',
        taskRef,
        subject,
        status: progress[0],
        signers: [
          { role: 'party_b', name: '王租客', email: 'tenant@example.com', status: progress[1] },
          { role: 'party_a', name: '林房東', email: 'landlord@example.com', status: progress[2] },
        ],
      }),
    );
  }
  return subject;
}

// 模組用固定的 A 組織開交易（測試不經 requestContext）
const dbA = (): SigningDb => ({
  requestOrg: async () => ({ kind: 'org', orgId: kit.orgA }),
  inOrg: (ctx, fn) => withTx(ctx, fn),
  inControl: (fn) => withTx({ kind: 'control' }, fn),
});

const moduleWith = (provider: SigningProvider = createMockProvider()) =>
  createSigningModule({ provider, subscribers: { contract: createContractSubscriber() }, files: createLocalFileStore(dataDir), db: dbA() });

// 保存文件經 adapter 下載。監看下載次數，就能知道完成後保存了幾次。
const watchedMock = () => {
  const provider = createMockProvider();
  const download = vi.spyOn(provider, 'downloadFile');
  return { provider, download };
};

const contractOf = (id: string) => inA((tx) => getContract(tx, id));
const eventsOf = (id: string) => inA((tx) => listContractEvents(tx, id));
const statusOf = async (id: string) => (await contractOf(id))?.status;
const eventTypes = async (id: string) => (await eventsOf(id)).map((e) => e.type);

const document: SignableDocument = {
  fileName: '租賃合約-測試物件',
  pdf: new Uint8Array([37, 80, 68, 70]),
  pageSize: { width: 595.28, height: 841.89 },
};
const signers: Signer[] = [
  { role: 'party_b', name: '王租客', email: 'tenant@example.com', signatureFields: [] },
  { role: 'party_a', name: '林房東', email: 'landlord@example.com', signatureFields: [] },
];

// live 模式下的 adapter 替身：實作都成功，各測試再覆寫要失敗的操作
const liveProvider = (overrides: Partial<SigningProvider> = {}): SigningProvider => ({
  id: 'dottedsign',
  mode: 'live',
  unsupported: { simulate: 'live 模式下請走真實 webhook' },
  createTask: async () => ({ taskRef: '470' }),
  getSignLink: async () => 'https://sign.example/abc',
  resend: async () => {},
  voidTask: async () => {},
  downloadFile: async (taskRef, kind) => new TextEncoder().encode(`${kind}-of-${taskRef}`),
  parseWebhook: () => ({ kind: 'ignored' }),
  ...overrides,
});

const refusal = (status: number, message: string) => expect.objectContaining({ name: 'SigningRefusal', status, message });

// 讓合約歷程寫入失敗，用來驗證同一交易的回滾
const failContractEventWrites = () =>
  kit.asOwner((pg) =>
    pg.exec(`CREATE FUNCTION org.fail_contract_events() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '歷程寫入失敗'; END $$;
             CREATE TRIGGER fail_contract_events BEFORE INSERT ON org.contract_events FOR EACH ROW EXECUTE FUNCTION org.fail_contract_events();`),
  );

describe('送簽', () => {
  it('回傳平台的簽署任務，合約進入待乙方簽並記送簽歷程', async () => {
    const subject = (await seed('draft'));
    const task = await moduleWith().send(subject, document, signers);

    expect(task).toEqual({ subject, mode: 'mock' });
    expect((await statusOf(subject.id))).toBe('awaiting_tenant');
    expect((await eventsOf(subject.id)).map((e) => [e.type, e.actor, e.note])).toEqual([
      ['sent', 'landlord', '寄送給乙方 tenant@example.com'],
    ]);
  });

  it('live 模式的簽署任務帶 live', async () => {
    const task = await moduleWith(liveProvider()).send((await seed('draft')), document, signers);
    expect(task.mode).toBe('live');
  });

  it('服務商建立任務失敗時，合約維持草稿，不記歷程', async () => {
    const subject = (await seed('draft'));
    const provider = liveProvider({
      createTask: async () => {
        throw new Error('點點簽 API 失敗（500）');
      },
    });
    await expect(moduleWith(provider).send(subject, document, signers)).rejects.toThrow('點點簽 API 失敗（500）');
    expect((await statusOf(subject.id))).toBe('draft');
    expect((await eventTypes(subject.id))).toEqual([]);
  });

  it('同一個簽署標的不能再送簽，也不呼叫服務商', async () => {
    const subject = (await seed('draft'));
    const createTask = vi.fn(async () => ({ taskRef: crypto.randomUUID() }));
    const signing = moduleWith(liveProvider({ createTask }));
    await signing.send(subject, document, signers);

    await expect(signing.send(subject, document, signers)).rejects.toEqual(refusal(409, '這個簽署標的已有簽署任務'));
    expect(createTask).toHaveBeenCalledTimes(1);
  });

  it('服務商任務編號已被其他簽署標的使用時，第二份合約維持草稿', async () => {
    const signing = moduleWith(liveProvider({ createTask: async () => ({ taskRef: '470' }) }));
    await signing.send((await seed('draft')), document, signers);

    const second = (await seed('draft'));
    await expect(signing.send(second, document, signers)).rejects.toEqual(
      refusal(409, '簽署標的或服務商任務編號已有簽署任務')
    );
    expect((await statusOf(second.id))).toBe('draft');
    expect((await eventTypes(second.id))).toEqual([]);
    await expect(signing.getProgress(second)).resolves.toBeNull();
  });

  it('合約歷程寫入失敗時，簽署任務與合約狀態一起回滾', async () => {
    const subject = (await seed('draft'));
    await failContractEventWrites();

    await expect(moduleWith().send(subject, document, signers)).rejects.toThrow('歷程寫入失敗');

    expect((await statusOf(subject.id))).toBe('draft');
    await expect(moduleWith().getProgress(subject)).resolves.toBeNull();
  });
});

describe('查簽署進度', () => {
  it('送簽後回傳簽署序列、各位狀態與當前簽署人', async () => {
    const subject = (await seed('draft'));
    const signing = moduleWith();
    await signing.send(subject, document, signers);

    await expect(signing.getProgress(subject)).resolves.toEqual({
      status: 'in_progress',
      signers: [
        { role: 'party_b', name: '王租客', email: 'tenant@example.com', status: 'pending', signedAt: null },
        { role: 'party_a', name: '林房東', email: 'landlord@example.com', status: 'pending', signedAt: null },
      ],
      currentSigner: { role: 'party_b', name: '王租客', email: 'tenant@example.com' },
    });
  });

  it('沒有簽署任務時回傳 null', async () => {
    await expect(moduleWith().getProgress((await seed('draft')))).resolves.toBeNull();
  });

  it('送簽後改合約欄位，簽署序列不變', async () => {
    const subject = (await seed('draft'));
    const signing = moduleWith();
    await signing.send(subject, document, signers);
    await inA((tx) =>
      tx.query('UPDATE org.contracts SET fields = $2::jsonb WHERE id = $1', [
        subject.id,
        JSON.stringify({ tenantName: '別人', tenantEmail: 'other@example.com' }),
      ]),
    );

    const progress = await signing.getProgress(subject);
    expect(progress?.currentSigner).toEqual({ role: 'party_b', name: '王租客', email: 'tenant@example.com' });
  });

  async function sent() {
    const subject = (await seed('draft'));
    const signing = moduleWith();
    await signing.send(subject, document, signers);
    return { subject, signing };
  }

  it('乙方簽署後，當前簽署人換成甲方，並記簽署時間', async () => {
    const { subject, signing } = await sent();
    await signing.simulateEvent(subject, 'signed');

    const progress = await signing.getProgress(subject);
    expect(progress?.status).toBe('in_progress');
    expect(progress?.signers.map((s) => s.status)).toEqual(['signed', 'pending']);
    expect(progress?.signers[0].signedAt).toEqual(expect.any(String));
    expect(progress?.currentSigner).toEqual({ role: 'party_a', name: '林房東', email: 'landlord@example.com' });
  });

  it('最後一位簽完：標為已簽，任務仍在進行中，不改合約狀態也不寫合約歷程', async () => {
    const { subject, signing } = await sent();
    await signing.simulateEvent(subject, 'signed');
    await expect(signing.simulateEvent(subject, 'signed')).resolves.toEqual({ status: 'awaiting_landlord' });

    const progress = await signing.getProgress(subject);
    expect(progress?.status).toBe('in_progress');
    expect(progress?.signers.map((s) => s.status)).toEqual(['signed', 'signed']);
    expect(progress?.currentSigner).toBeNull();
    expect((await statusOf(subject.id))).toBe('awaiting_landlord');
    expect((await eventTypes(subject.id))).toEqual(['sent', 'signer_signed']);
  });

  it('全員完成把未簽者標為已簽，任務完成，沒有當前簽署人', async () => {
    const { subject, signing } = await sent();
    await signing.simulateEvent(subject, 'completed');

    const progress = await signing.getProgress(subject);
    expect(progress?.status).toBe('completed');
    expect(progress?.signers.map((s) => s.status)).toEqual(['signed', 'signed']);
    expect(progress?.signers.every((s) => s.signedAt)).toBe(true);
    expect(progress?.currentSigner).toBeNull();
  });

  it('甲方拒簽時，甲方標為拒簽，乙方維持已簽', async () => {
    const { subject, signing } = await sent();
    await signing.simulateEvent(subject, 'signed');
    await signing.simulateEvent(subject, 'declined', '想再考慮');

    const progress = await signing.getProgress(subject);
    expect(progress?.status).toBe('declined');
    expect(progress?.signers.map((s) => s.status)).toEqual(['signed', 'declined']);
    expect(progress?.signers[1].signedAt).toBeNull();
    expect(progress?.currentSigner).toBeNull();
  });

  it('撤回後任務已撤回，簽署人狀態不變', async () => {
    const { subject, signing } = await sent();
    await signing.simulateEvent(subject, 'signed');
    await signing.voidTask(subject);

    const progress = await signing.getProgress(subject);
    expect(progress?.status).toBe('voided');
    expect(progress?.signers.map((s) => s.status)).toEqual(['signed', 'pending']);
    expect(progress?.currentSigner).toBeNull();
  });

  it('合約狀態不接受的事件不推進簽署進度', async () => {
    const { subject, signing } = await sent();
    await signing.simulateEvent(subject, 'completed');
    await expect(signing.simulateEvent(subject, 'declined', '太晚了')).rejects.toEqual(
      refusal(409, '目前狀態（completed）不接受此事件')
    );

    const progress = await signing.getProgress(subject);
    expect(progress?.status).toBe('completed');
    expect(progress?.signers.map((s) => s.status)).toEqual(['signed', 'signed']);
  });

  it('合約歷程寫入失敗時，簽署進度與合約狀態一起回滾', async () => {
    const { subject, signing } = await sent();
    await failContractEventWrites();

    await expect(signing.simulateEvent(subject, 'signed')).rejects.toThrow('歷程寫入失敗');

    expect((await statusOf(subject.id))).toBe('awaiting_tenant');
    const progress = await signing.getProgress(subject);
    expect(progress?.signers.map((s) => s.status)).toEqual(['pending', 'pending']);
  });

  // MIL-85：簽署進度與合約狀態、歷程是同一個交易。進度寫入失敗時合約也不前進，重送同一事件從頭處理，
  // 歷程不會多記（過渡期曾有 signer_signed 多一筆的缺口）。
  it('簽署進度寫入失敗時，合約狀態與歷程一起回滾，重送同一事件乾淨地補上', async () => {
    const { subject, signing } = await sent();
    await kit.asOwner((pg) =>
      pg.exec(`CREATE FUNCTION org.fail_signers() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '進度寫入失敗'; END $$;
               CREATE TRIGGER fail_signers BEFORE UPDATE ON org.signers FOR EACH ROW EXECUTE FUNCTION org.fail_signers();`),
    );

    await expect(signing.simulateEvent(subject, 'signed')).rejects.toThrow('進度寫入失敗');

    expect((await signing.getProgress(subject))?.signers.map((s) => s.status)).toEqual(['pending', 'pending']);
    expect(await statusOf(subject.id)).toBe('awaiting_tenant');
    expect(await eventTypes(subject.id)).toEqual(['sent']);

    await kit.asOwner((pg) => pg.exec('DROP TRIGGER fail_signers ON org.signers'));
    await signing.simulateEvent(subject, 'signed');
    expect((await signing.getProgress(subject))?.signers.map((s) => s.status)).toEqual(['signed', 'pending']);
    expect(await eventTypes(subject.id)).toEqual(['sent', 'signer_signed']);
  });
});

describe('任務比對與當前簽署人讀簽署任務', () => {
  // 合約欄位不是簽署人的來源：送簽後把它改掉，操作仍要對到建立時的任務與簽署人
  async function sentThenLegacyColumnsChanged(provider: SigningProvider) {
    const subject = (await seed('draft'));
    const signing = moduleWith(provider);
    await signing.send(subject, document, signers);
    await inA((tx) =>
      tx.query('UPDATE org.contracts SET fields = $2::jsonb WHERE id = $1', [
        subject.id,
        JSON.stringify({ tenantName: '別人', tenantEmail: 'other@example.com' }),
      ]),
    );
    return { subject, signing };
  }
  const WANG = { role: 'party_b', name: '王租客', email: 'tenant@example.com' };

  it('取簽署連結', async () => {
    const getSignLink = vi.fn(async () => 'https://sign.example/abc');
    const { subject, signing } = await sentThenLegacyColumnsChanged(liveProvider({ getSignLink }));

    await expect(signing.getSignLink(subject)).resolves.toMatchObject({ signer: WANG });
    expect(getSignLink).toHaveBeenCalledWith('470', 'tenant@example.com', undefined);
  });

  it('重寄', async () => {
    const resend = vi.fn(async () => {});
    const { subject, signing } = await sentThenLegacyColumnsChanged(liveProvider({ resend }));

    await expect(signing.resend(subject)).resolves.toEqual({ signer: WANG });
    expect(resend).toHaveBeenCalledWith('470');
  });

  it('撤回', async () => {
    const voidTask = vi.fn(async () => {});
    const { subject, signing } = await sentThenLegacyColumnsChanged(liveProvider({ voidTask }));

    await signing.voidTask(subject);
    expect(voidTask).toHaveBeenCalledWith('470');
  });

  it('webhook', async () => {
    const parseWebhook: SigningProvider['parseWebhook'] = (rawBody) => ({
      kind: 'event',
      taskRef: rawBody,
      event: { type: 'signed', email: 'tenant@example.com' },
    });
    const { subject, signing } = await sentThenLegacyColumnsChanged(liveProvider({ parseWebhook }));

    await expect(signing.ingestWebhook('stale-ref', new Headers())).resolves.toEqual({
      status: 200,
      body: { ok: true, ignored: true },
    });
    expect((await statusOf(subject.id))).toBe('awaiting_tenant');

    await signing.ingestWebhook('470', new Headers());
    expect((await statusOf(subject.id))).toBe('awaiting_landlord');
  });
});

describe('mode', () => {
  it('回答目前 adapter 的模式', async () => {
    await expect(moduleWith().mode()).resolves.toBe('mock');
    await expect(moduleWith(liveProvider()).mode()).resolves.toBe('live');
  });
});

describe('接收 webhook', () => {
  const webhook = (taskRef: string, action: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ resource_id: taskRef, resource_type: 'task', action_name: action, ...extra });

  it('空 body 回 200 ping', async () => {
    await expect(moduleWith().ingestWebhook('', new Headers())).resolves.toEqual({
      status: 200,
      body: { ok: true, ping: true },
    });
  });

  it('adapter 判定無效時，回 adapter 給的狀態碼與原因', async () => {
    await expect(moduleWith().ingestWebhook('not-json', new Headers())).resolves.toEqual({
      status: 400,
      body: { error: 'invalid json' },
    });
    const provider = liveProvider({
      parseWebhook: () => ({ kind: 'invalid', status: 401, reason: 'invalid signature' }),
    });
    await expect(moduleWith(provider).ingestWebhook('{}', new Headers())).resolves.toEqual({
      status: 401,
      body: { error: 'invalid signature' },
    });
  });

  it('忽略的事件回 200 ignored', async () => {
    const subject = (await seed('awaiting_tenant', 'mock-task-1'));
    await expect(moduleWith().ingestWebhook(webhook('mock-task-1', 'viewed'), new Headers())).resolves.toEqual({
      status: 200,
      body: { ok: true, ignored: true },
    });
    expect((await statusOf(subject.id))).toBe('awaiting_tenant');
  });

  it('找不到對應合約時回 200 ignored', async () => {
    await expect(moduleWith().ingestWebhook(webhook('no-such-task', 'signed'), new Headers())).resolves.toEqual({
      status: 200,
      body: { ok: true, ignored: true },
    });
  });

  it('走完乙方簽署到全員完成：狀態、歷程都推進，完成後保存文件一次', async () => {
    const subject = (await seed('awaiting_tenant', 'mock-task-1'));
    const { provider, download } = watchedMock();
    const signing = moduleWith(provider);

    await expect(
      signing.ingestWebhook(webhook('mock-task-1', 'signed', { event_email: 'tenant@example.com' }), new Headers())
    ).resolves.toEqual({
      status: 200,
      body: { ok: true },
    });
    expect((await statusOf(subject.id))).toBe('awaiting_landlord');
    expect(download).not.toHaveBeenCalled();

    await signing.ingestWebhook(webhook('mock-task-1', 'completed'), new Headers());
    expect((await statusOf(subject.id))).toBe('completed');
    expect((await eventTypes(subject.id))).toEqual(['signer_signed', 'completed']);
    // mock 沒有 Audit Trail File，只保存已簽 PDF
    expect(download.mock.calls).toEqual([['mock-task-1', 'signed_pdf']]);
  });

  it('重複的 completed 回 200，不再推進，也不再保存文件', async () => {
    const subject = (await seed('awaiting_landlord', 'mock-task-1'));
    const { provider, download } = watchedMock();
    const signing = moduleWith(provider);
    await signing.ingestWebhook(webhook('mock-task-1', 'completed'), new Headers());
    await expect(signing.ingestWebhook(webhook('mock-task-1', 'completed'), new Headers())).resolves.toEqual({
      status: 200,
      body: { ok: true, ignored: true },
    });
    expect((await eventTypes(subject.id))).toEqual(['completed']);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('拒簽原因寫進合約與歷程附註', async () => {
    const subject = (await seed('awaiting_tenant', 'mock-task-1'));
    await moduleWith().ingestWebhook(webhook('mock-task-1', 'declined', { other_info: { reason: '租金認知有落差' } }), new Headers());
    expect((await contractOf(subject.id))).toMatchObject({ status: 'declined', declined_reason: '租金認知有落差' });
    expect((await eventsOf(subject.id))[0]).toMatchObject({ type: 'declined', note: '租金認知有落差' });
  });
});

describe('模擬簽署事件（mock advance）', () => {
  it('mock 模式能推進到完成，回傳下一狀態，完成後保存文件', async () => {
    const subject = (await seed('awaiting_tenant', 'mock-1-abc'));
    const { provider, download } = watchedMock();
    const signing = moduleWith(provider);
    await expect(signing.simulateEvent(subject, 'signed')).resolves.toEqual({ status: 'awaiting_landlord' });
    await expect(signing.simulateEvent(subject, 'completed')).resolves.toEqual({ status: 'completed' });
    expect((await eventTypes(subject.id))).toEqual(['signer_signed', 'completed']);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('拒簽原因會傳進歷程', async () => {
    const subject = (await seed('awaiting_tenant', 'mock-1-abc'));
    await moduleWith().simulateEvent(subject, 'declined', '想再考慮');
    expect((await eventsOf(subject.id))[0]).toMatchObject({ type: 'declined', note: '想再考慮' });
  });

  it('live 模式回 403，訊息不變', async () => {
    const subject = (await seed('awaiting_tenant', '470'));
    await expect(moduleWith(liveProvider()).simulateEvent(subject, 'signed')).rejects.toEqual(
      refusal(403, 'live 模式下請走真實 webhook')
    );
    expect((await statusOf(subject.id))).toBe('awaiting_tenant');
  });

  it('合約不存在回 404', async () => {
    await expect(moduleWith().simulateEvent({ type: 'contract', id: ulidOf(999) }, 'signed')).rejects.toEqual(
      refusal(404, '合約不存在')
    );
  });

  it.each(['voided', 'viewed', undefined])('不支援的事件 %s 回 400', async (event) => {
    await expect(moduleWith().simulateEvent((await seed('awaiting_tenant', 'mock-1-abc')), event)).rejects.toEqual(
      refusal(400, '不支援的事件')
    );
  });

  it('狀態不接受時回 409，訊息帶目前狀態', async () => {
    await expect(moduleWith().simulateEvent((await seed('draft')), 'signed')).rejects.toEqual(
      refusal(409, '目前狀態（draft）不接受此事件')
    );
  });

  it('模擬的簽署事件帶事件時間，記為簽署時間；全員完成時未簽者也用這個時間', async () => {
    const subject = (await seed('awaiting_tenant', 'mock-1-abc'));
    const instants = [new Date('2026-11-08T02:03:04.000Z'), new Date('2026-11-08T05:06:07.000Z')];
    const signing = createSigningModule({
      provider: createMockProvider(),
      subscribers: { contract: createContractSubscriber() },
      files: createLocalFileStore(dataDir),
      now: () => instants.shift()!,
      db: dbA(),
    });

    await signing.simulateEvent(subject, 'signed');
    await signing.simulateEvent(subject, 'completed');

    const progress = await signing.getProgress(subject);
    const signedAt = progress!.signers.map((s) => s.signedAt);
    expect(signedAt).toEqual(['2026-11-08T02:03:04.000Z', '2026-11-08T05:06:07.000Z']);
  });
});

describe('兼任角色與驗證設定', () => {
  const PRACTITIONER_AND_PARTY_A: Signer = {
    role: 'practitioner',
    name: '陳管理',
    email: 'manager@example.com',
    concurrentRoles: ['party_a'],
    verifyMethods: ['email'],
    signatureFields: [
      { id: 'f1', signer: 'practitioner', page: 0, x: 0.1, y: 0.8, w: 0.2, h: 0.1 },
      { id: 'f2', signer: 'party_a', page: 1, x: 0.6, y: 0.8, w: 0.2, h: 0.1 },
    ],
  };
  const PARTY_B: Signer = { role: 'party_b', name: '王租客', email: 'tenant@example.com', signatureFields: [] };

  it('送簽時記下兼任角色，查簽署進度時回傳；沒有兼任的簽署人不帶這個欄位', async () => {
    const subject = (await seed('draft'));
    const signing = moduleWith();
    await signing.send(subject, document, [PARTY_B, PRACTITIONER_AND_PARTY_A]);

    const progress = await signing.getProgress(subject);
    expect(progress?.signers[0]).not.toHaveProperty('concurrentRoles');
    expect(progress?.signers[1]).toMatchObject({ role: 'practitioner', concurrentRoles: ['party_a'] });
  });

  it('簽署進度推進後，兼任角色仍在', async () => {
    const subject = (await seed('draft'));
    const signing = moduleWith();
    await signing.send(subject, document, [PARTY_B, PRACTITIONER_AND_PARTY_A]);
    await signing.simulateEvent(subject, 'signed');
    await signing.simulateEvent(subject, 'completed');

    const progress = await signing.getProgress(subject);
    expect(progress?.signers[1]).toMatchObject({ status: 'signed', concurrentRoles: ['party_a'] });
  });

  it('兼任的簽署人整份傳給 adapter，簽署區域與驗證設定都不遺失', async () => {
    const subject = (await seed('draft'));
    const createTask = vi.fn(async () => ({ taskRef: '470' }));
    await moduleWith(liveProvider({ createTask })).send(subject, document, [PRACTITIONER_AND_PARTY_A]);
    expect(createTask).toHaveBeenCalledWith({ subject, document, signers: [PRACTITIONER_AND_PARTY_A] });
  });

  it('簽署人表只有簽署進度需要的欄位，沒有電話與身分證字號', async () => {
    const { rows } = await kit.asOwner((pg) =>
      pg.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'org' AND table_name = 'signers'`,
      ),
    );
    expect(rows.map((r) => r.column_name).sort()).toEqual(
      [
        'concurrent_roles', 'email', 'id', 'legacy_id', 'name', 'org_id', 'position',
        'role', 'sign_task_id', 'signed_at', 'status',
      ].sort(),
    );
  });
});

describe('取簽署連結', () => {
  const redirect = 'https://app.example/contracts/1';

  it('回傳當前簽署人與連結，連結對應當前簽署人的 email', async () => {
    const subject = (await seed('awaiting_landlord', '470'));
    const getSignLink = vi.fn(async () => 'https://sign.example/abc');
    await expect(moduleWith(liveProvider({ getSignLink })).getSignLink(subject, redirect)).resolves.toEqual({
      signer: { role: 'party_a', name: '林房東', email: 'landlord@example.com' },
      url: 'https://sign.example/abc',
    });
    expect(getSignLink).toHaveBeenCalledWith('470', 'landlord@example.com', redirect);
  });

  it('mock 模式回 409，即使合約不在簽署中也先回 mock 訊息', async () => {
    await expect(moduleWith().getSignLink((await seed('draft')), redirect)).rejects.toEqual(
      refusal(409, 'mock 模式無簽署連結')
    );
  });

  it.each([
    ['不在簽署中', 'draft', '470'],
    ['沒有任務編號', 'awaiting_tenant', null],
  ] as const)('%s回 409', async (_label, status, taskRef) => {
    await expect(moduleWith(liveProvider()).getSignLink((await seed(status, taskRef)), redirect)).rejects.toEqual(
      refusal(409, '合約不在簽署中，沒有待簽方')
    );
  });

  it('合約不存在回 404', async () => {
    await expect(moduleWith(liveProvider()).getSignLink({ type: 'contract', id: ulidOf(999) }, redirect)).rejects.toEqual(
      refusal(404, '合約不存在')
    );
  });
});

describe('重寄', () => {
  it('回傳當前簽署人', async () => {
    const subject = (await seed('awaiting_tenant', '470'));
    const resend = vi.fn(async () => {});
    await expect(moduleWith(liveProvider({ resend })).resend(subject)).resolves.toEqual({
      signer: { role: 'party_b', name: '王租客', email: 'tenant@example.com' },
    });
    expect(resend).toHaveBeenCalledWith('470');
  });

  it('mock 模式回 409，即使合約不在簽署中也先回 mock 訊息', async () => {
    await expect(moduleWith().resend((await seed('draft')))).rejects.toEqual(refusal(409, 'mock 模式不寄信'));
  });

  it('不在簽署中回 409', async () => {
    await expect(moduleWith(liveProvider()).resend((await seed('completed', '470')))).rejects.toEqual(
      refusal(409, '合約不在簽署中，沒有待簽方')
    );
  });
});

describe('撤回', () => {
  it('撤回服務商任務，合約進入已撤回並記歷程', async () => {
    const subject = (await seed('awaiting_landlord', '470'));
    const voidTask = vi.fn(async () => {});
    await expect(moduleWith(liveProvider({ voidTask })).voidTask(subject)).resolves.toBeUndefined();
    expect(voidTask).toHaveBeenCalledWith('470');
    expect((await statusOf(subject.id))).toBe('voided');
    expect((await eventTypes(subject.id))).toEqual(['voided']);
  });

  it('簽署中但沒有任務編號時，不呼叫服務商，仍能撤回', async () => {
    const subject = (await seed('awaiting_tenant'));
    const voidTask = vi.fn(async () => {});
    await moduleWith(liveProvider({ voidTask })).voidTask(subject);
    expect(voidTask).not.toHaveBeenCalled();
    expect((await statusOf(subject.id))).toBe('voided');
  });

  it('mock 模式也能撤回', async () => {
    const subject = (await seed('awaiting_tenant', 'mock-1-abc'));
    await moduleWith().voidTask(subject);
    expect((await statusOf(subject.id))).toBe('voided');
  });

  it('不在簽署中回 409', async () => {
    await expect(moduleWith().voidTask((await seed('draft')))).rejects.toEqual(refusal(409, '僅簽署中的合約可撤回'));
  });

  it('已結束的任務回 409，也不呼叫服務商', async () => {
    const subject = (await seed('completed', '470'));
    const voidTask = vi.fn(async () => {});
    await expect(moduleWith(liveProvider({ voidTask })).voidTask(subject)).rejects.toEqual(
      refusal(409, '僅簽署中的合約可撤回')
    );
    expect(voidTask).not.toHaveBeenCalled();
  });

  it('呼叫服務商撤回期間收到全員完成事件時，合約維持已完成', async () => {
    const subject = (await seed('awaiting_landlord', '470'));
    const parseWebhook: SigningProvider['parseWebhook'] = () => ({
      kind: 'event',
      taskRef: '470',
      event: { type: 'completed' },
    });
    const signing = moduleWith(
      liveProvider({
        parseWebhook,
        voidTask: async () => {
          await signing.ingestWebhook('{}', new Headers());
        },
      })
    );

    await expect(signing.voidTask(subject)).rejects.toEqual(refusal(409, '僅簽署中的合約可撤回'));

    expect((await statusOf(subject.id))).toBe('completed');
    expect((await eventTypes(subject.id))).toEqual(['completed']);
    await expect(signing.getProgress(subject)).resolves.toMatchObject({ status: 'completed' });
  });

  it('服務商撤回失敗時，合約維持簽署中', async () => {
    const subject = (await seed('awaiting_tenant', '470'));
    const provider = liveProvider({
      voidTask: async () => {
        throw new Error('點點簽 API 失敗（403）');
      },
    });
    await expect(moduleWith(provider).voidTask(subject)).rejects.toThrow('點點簽 API 失敗（403）');
    expect((await statusOf(subject.id))).toBe('awaiting_tenant');
    expect((await eventTypes(subject.id))).toEqual([]);
  });
});

describe('送簽檢查：email 不得重複', () => {
  const duplicated = (first: string, second: string): Signer[] => [
    { ...signers[0], email: first },
    { ...signers[1], email: second },
  ];

  it.each([
    ['完全相同', 'same@example.com', 'same@example.com'],
    ['大小寫不同', 'Same@Example.com', 'same@example.COM'],
    ['前後有空白', ' same@example.com', 'same@example.com '],
  ])('%s時擋下，訊息明確，也不呼叫服務商', async (_label, first, second) => {
    const subject = (await seed('draft'));
    const createTask = vi.fn(async () => ({ taskRef: '470' }));
    await expect(moduleWith(liveProvider({ createTask })).send(subject, document, duplicated(first, second))).rejects.toEqual(
      refusal(400, `簽署人的 email 重複：${second}。每位簽署人必須使用不同的 email，請修正後再送簽。`)
    );
    expect(createTask).not.toHaveBeenCalled();
    expect((await statusOf(subject.id))).toBe('draft');
  });

  it('簽署序列是空的時擋下', async () => {
    await expect(moduleWith().send((await seed('draft')), document, [])).rejects.toEqual(refusal(400, '簽署序列不得為空'));
  });
});

describe('email 守門', () => {
  const WEBHOOK = (action: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ resource_id: 'mock-task-1', resource_type: 'task', action_name: action, ...extra });
  const IGNORED = { status: 200, body: { ok: true, ignored: true } };
  const signed = (event_email?: string) => WEBHOOK('signed', event_email ? { event_email } : {});

  it('第一位的重試不推進第二位，回 2xx', async () => {
    const subject = (await seed('awaiting_tenant', 'mock-task-1'));
    const signing = moduleWith();
    await signing.ingestWebhook(signed('tenant@example.com'), new Headers());

    await expect(signing.ingestWebhook(signed('tenant@example.com'), new Headers())).resolves.toEqual(IGNORED);

    const progress = await signing.getProgress(subject);
    expect(progress?.signers.map((s) => s.status)).toEqual(['signed', 'pending']);
    expect((await statusOf(subject.id))).toBe('awaiting_landlord');
    expect((await eventTypes(subject.id))).toEqual(['signer_signed']);
  });

  it('email 不是當前簽署人時忽略，回 2xx', async () => {
    const subject = (await seed('awaiting_tenant', 'mock-task-1'));
    await expect(moduleWith().ingestWebhook(signed('landlord@example.com'), new Headers())).resolves.toEqual(IGNORED);
    expect((await statusOf(subject.id))).toBe('awaiting_tenant');
  });

  it('事件沒有 email 時忽略，回 2xx', async () => {
    const subject = (await seed('awaiting_tenant', 'mock-task-1'));
    await expect(moduleWith().ingestWebhook(signed(), new Headers())).resolves.toEqual(IGNORED);
    expect((await statusOf(subject.id))).toBe('awaiting_tenant');
  });

  it('比對不分大小寫', async () => {
    const subject = (await seed('awaiting_tenant', 'mock-task-1'));
    await expect(moduleWith().ingestWebhook(signed('TENANT@Example.com'), new Headers())).resolves.toEqual({
      status: 200,
      body: { ok: true },
    });
    expect((await statusOf(subject.id))).toBe('awaiting_landlord');
  });

  it.each(['signed', 'completed', 'declined', 'voided'])('任務結束後的 %s 被忽略，回 2xx', async (action) => {
    const subject = (await seed('completed', 'mock-task-1'));
    await expect(
      moduleWith().ingestWebhook(WEBHOOK(action, { event_email: 'tenant@example.com' }), new Headers())
    ).resolves.toEqual(IGNORED);
    expect((await statusOf(subject.id))).toBe('completed');
    expect((await eventTypes(subject.id))).toEqual([]);
  });

  it('全員完成先到時，未簽者都標為已簽，之後才到的簽署人已簽被忽略', async () => {
    const subject = (await seed('awaiting_tenant', 'mock-task-1'));
    const signing = moduleWith();
    await signing.ingestWebhook(WEBHOOK('completed'), new Headers());

    await expect(signing.ingestWebhook(signed('tenant@example.com'), new Headers())).resolves.toEqual(IGNORED);

    const progress = await signing.getProgress(subject);
    expect(progress?.signers.map((s) => s.status)).toEqual(['signed', 'signed']);
    expect((await eventTypes(subject.id))).toEqual(['completed']);
  });
});

describe('N 位簽署人經 seam 走完', () => {
  const PARTY_B: Signer = { role: 'party_b', name: '王租客', email: 'tenant@example.com', signatureFields: [] };
  const PRACTITIONER: Signer = { role: 'practitioner', name: '陳管理', email: 'manager@example.com', signatureFields: [] };
  const PARTY_A: Signer = { role: 'party_a', name: '林房東', email: 'landlord@example.com', signatureFields: [] };
  const STATUS_OF = { party_b: 'awaiting_tenant', practitioner: 'awaiting_practitioner', party_a: 'awaiting_landlord' };

  // 只用 webhook 推進，與真實路徑相同。任務編號固定，webhook 才對得到。
  const webhookProvider = (): SigningProvider => ({
    ...createMockProvider(),
    createTask: async () => ({ taskRef: '470' }),
  });
  const webhook = (action: string, event_email?: string) =>
    JSON.stringify({ resource_id: '470', resource_type: 'task', action_name: action, event_email });

  it.each<[string, Signer[]]>([
    ['乙方、執業人員、甲方', [PARTY_B, PRACTITIONER, PARTY_A]],
    ['順序對調：甲方、執業人員、乙方', [PARTY_A, PRACTITIONER, PARTY_B]],
    ['順序對調：執業人員、甲方、乙方', [PRACTITIONER, PARTY_A, PARTY_B]],
  ])('%s', async (_label, sequence) => {
    const subject = (await seed('draft'));
    const signing = moduleWith(webhookProvider());
    await signing.send(subject, document, sequence);
    expect((await statusOf(subject.id))).toBe(STATUS_OF[sequence[0].role]);

    // 前兩位簽完，合約狀態依下一位的角色投影，當前簽署人跟著換
    for (const index of [0, 1]) {
      await signing.ingestWebhook(webhook('signed', sequence[index].email), new Headers());
      expect((await statusOf(subject.id))).toBe(STATUS_OF[sequence[index + 1].role]);
      const progress = await signing.getProgress(subject);
      expect(progress?.currentSigner?.email).toBe(sequence[index + 1].email);
    }

    // 最後一位簽完不改合約狀態，也不寫合約歷程
    await signing.ingestWebhook(webhook('signed', sequence[2].email), new Headers());
    expect((await statusOf(subject.id))).toBe(STATUS_OF[sequence[2].role]);
    await expect(signing.getProgress(subject)).resolves.toMatchObject({ status: 'in_progress', currentSigner: null });

    await signing.ingestWebhook(webhook('completed'), new Headers());
    expect((await statusOf(subject.id))).toBe('completed');
    expect((await eventsOf(subject.id)).map((e) => [e.type, e.actor])).toEqual([
      ['sent', 'landlord'],
      ['signer_signed', sequence[0].role],
      ['signer_signed', sequence[1].role],
      ['completed', 'system'],
    ]);
    const progress = await signing.getProgress(subject);
    expect(progress?.status).toBe('completed');
    expect(progress?.signers.map((s) => s.status)).toEqual(['signed', 'signed', 'signed']);
  });

  it('一位簽署人：簽完等全員完成', async () => {
    const subject = (await seed('draft'));
    const signing = moduleWith(webhookProvider());
    await signing.send(subject, document, [PARTY_A]);
    expect((await statusOf(subject.id))).toBe('awaiting_landlord');

    await signing.ingestWebhook(webhook('signed', PARTY_A.email), new Headers());
    expect((await statusOf(subject.id))).toBe('awaiting_landlord');

    await signing.ingestWebhook(webhook('completed'), new Headers());
    expect((await statusOf(subject.id))).toBe('completed');
  });

  it('第二位拒簽：拒簽者標為拒簽，第三位維持待簽，行為者是第二位的角色', async () => {
    const subject = (await seed('draft'));
    const signing = moduleWith(webhookProvider());
    await signing.send(subject, document, [PARTY_B, PRACTITIONER, PARTY_A]);
    await signing.ingestWebhook(webhook('signed', PARTY_B.email), new Headers());
    await signing.ingestWebhook(
      JSON.stringify({
        resource_id: '470',
        resource_type: 'task',
        action_name: 'declined',
        other_info: { reason: '證照待確認' },
      }),
      new Headers()
    );

    const progress = await signing.getProgress(subject);
    expect(progress?.signers.map((s) => s.status)).toEqual(['signed', 'declined', 'pending']);
    expect((await contractOf(subject.id))).toMatchObject({ status: 'declined', declined_reason: '證照待確認' });
    expect((await eventsOf(subject.id)).at(-1)).toMatchObject({
      type: 'declined',
      actor: 'practitioner',
      note: '證照待確認',
    });
  });

  it('待執業人員簽（第三位還沒簽）時能撤回', async () => {
    const subject = (await seed('draft'));
    const signing = moduleWith(webhookProvider());
    await signing.send(subject, document, [PARTY_B, PRACTITIONER, PARTY_A]);
    await signing.ingestWebhook(webhook('signed', PARTY_B.email), new Headers());
    expect((await statusOf(subject.id))).toBe('awaiting_practitioner');

    await signing.voidTask(subject);

    expect((await statusOf(subject.id))).toBe('voided');
    const progress = await signing.getProgress(subject);
    expect(progress?.signers.map((s) => s.status)).toEqual(['signed', 'pending', 'pending']);
  });

  it('待執業人員簽時，簽署連結與重寄都對執業人員', async () => {
    const subject = (await seed('draft'));
    const getSignLink = vi.fn(async () => 'https://sign.example/abc');
    const resend = vi.fn(async () => {});
    const signing = moduleWith({
      ...liveProvider({ getSignLink, resend }),
      parseWebhook: () => ({ kind: 'event', taskRef: '470', event: { type: 'signed', email: PARTY_B.email } }),
    });
    await signing.send(subject, document, [PARTY_B, PRACTITIONER, PARTY_A]);
    await signing.ingestWebhook('{}', new Headers());
    expect((await statusOf(subject.id))).toBe('awaiting_practitioner');

    const practitioner = { role: 'practitioner', name: '陳管理', email: 'manager@example.com' };
    await expect(signing.getSignLink(subject)).resolves.toEqual({
      signer: practitioner,
      url: 'https://sign.example/abc',
    });
    expect(getSignLink).toHaveBeenCalledWith('470', 'manager@example.com', undefined);
    await expect(signing.resend(subject)).resolves.toEqual({ signer: practitioner });
    expect(resend).toHaveBeenCalledWith('470');
  });

  it('webhook 帶事件時間時，記為簽署時間', async () => {
    const subject = (await seed('draft'));
    const signing = moduleWith({
      ...createMockProvider(),
      createTask: async () => ({ taskRef: '470' }),
      parseWebhook: () => ({
        kind: 'event',
        taskRef: '470',
        event: { type: 'signed', email: PARTY_B.email, occurredAt: '2026-11-08T02:03:04.000Z' },
      }),
    });
    await signing.send(subject, document, [PARTY_B, PARTY_A]);

    await signing.ingestWebhook('{}', new Headers());

    const progress = await signing.getProgress(subject);
    expect(new Date(progress!.signers[0].signedAt!).toISOString()).toBe('2026-11-08T02:03:04.000Z');
  });
});

describe('點點簽 sandbox 實測的 webhook 回放（MIL-54，任務 346、348）', () => {
  const SECRET = 'test-secret';
  // 只留 adapter 讀的欄位與 other_info，其他值與實測相同。task 欄位很大，這裡省略。
  const payload = (action: string, email: string, datetime: number, other_info: Record<string, unknown> = {}) =>
    JSON.stringify({
      resource_id: 346,
      resource_type: 'task',
      event_datetime: datetime,
      action_name: action,
      event_email: email,
      ip_address: '203.121.236.45, 15.158.247.73',
      user_agent: 'DottedSign on Other Other',
      other_info,
    });
  const signedHeaders = (body: string) =>
    new Headers({ signature: nodeCrypto.createHmac('sha256', SECRET).update(body).digest('hex') });
  const sequence: Signer[] = [
    { role: 'party_b', name: 'C', email: 'Mil54-C@Example.com', signatureFields: [] },
    { role: 'practitioner', name: 'B', email: 'mil54-b@example.com', signatureFields: [] },
    { role: 'party_a', name: 'A', email: 'mil54-a@example.com', signatureFields: [] },
  ];

  async function sentOverDottedSign() {
    const subject = (await seed('draft'));
    const signing = moduleWith(
      createDottedSignProvider({ request: async () => ({ data: { task_id: 346 } }), clientSecret: SECRET })
    );
    await signing.send(subject, document, sequence);
    const deliver = (body: string) => signing.ingestWebhook(body, signedHeaders(body));
    return { subject, signing, deliver };
  }

  it('實測的事件序列走到完成：viewed、sent 被忽略，email 全小寫也對得到', async () => {
    const { subject, signing, deliver } = await sentOverDottedSign();

    await deliver(payload('viewed', 'mil54-c@example.com', 1794073307));
    await deliver(payload('sent', 'owner@example.com', 1794073299));
    await deliver(payload('signed', 'mil54-c@example.com', 1794073308));
    expect((await statusOf(subject.id))).toBe('awaiting_practitioner');
    await deliver(payload('signed', 'mil54-b@example.com', 1794073348));
    expect((await statusOf(subject.id))).toBe('awaiting_landlord');
    await deliver(payload('signed', 'mil54-a@example.com', 1794073352));
    expect((await statusOf(subject.id))).toBe('awaiting_landlord');
    // 實測的 completed 事件，event_email 是字串 Server
    await deliver(payload('completed', 'Server', 1794073361));

    expect((await statusOf(subject.id))).toBe('completed');
    const progress = await signing.getProgress(subject);
    expect(progress?.signers.map((s) => s.status)).toEqual(['signed', 'signed', 'signed']);
    expect(new Date(progress!.signers[0].signedAt!).getTime() / 1000).toBe(1794073308);
  });

  it('重複投遞的 signed 不推進', async () => {
    const { subject, signing, deliver } = await sentOverDottedSign();
    const first = payload('signed', 'mil54-c@example.com', 1794073308);
    await deliver(first);

    await expect(deliver(first)).resolves.toEqual({ status: 200, body: { ok: true, ignored: true } });

    const progress = await signing.getProgress(subject);
    expect(progress?.signers.map((s) => s.status)).toEqual(['signed', 'pending', 'pending']);
  });

  it('實測的拒簽：原因在 other_info.reason，拒簽者是當前簽署人', async () => {
    const { subject, signing, deliver } = await sentOverDottedSign();
    await deliver(payload('signed', 'mil54-c@example.com', 1794073360));

    await deliver(payload('declined', 'mil54-b@example.com', 1794073362, { reason: '測試拒簽原因：租金認知有落差' }));

    expect((await contractOf(subject.id))).toMatchObject({
      status: 'declined',
      declined_reason: '測試拒簽原因：租金認知有落差',
    });
    const progress = await signing.getProgress(subject);
    expect(progress?.signers.map((s) => s.status)).toEqual(['signed', 'declined', 'pending']);
  });
});

describe('簽署模組不依賴合約', () => {
  // 假的簽署標的：沒有對應的合約列，只記錄訂閱者收到什麼
  const FAKE = { type: 'disbursement_instruction', id: ulidOf(77) };
  const signerA: Signer = { role: 'party_a', name: '財務甲', email: 'a@example.com', signatureFields: [] };
  const signerB: Signer = { role: 'party_b', name: '財務乙', email: 'b@example.com', signatureFields: [] };

  function fakeSubscriber(overrides: Partial<SigningSubscriber> = {}) {
    const log: unknown[] = [];
    const subscriber: SigningSubscriber = {
      label: '撥款指示',
      exists: async (_tx, subject) => subject.id === FAKE.id,
      currentStatus: async () => 'fake-status',
      isCompleted: async () => log.includes('completed'),
      onSent: async (_tx, _subject, sent) => {
        log.push(['sent', sent.signers.length]);
      },
      onOutcome: async (_tx, _subject, outcome) => {
        log.push(outcome.type);
      },
      afterCompleted: async () => {
        log.push('afterCompleted');
      },
      voidWithoutTask: async () => {
        log.push('voidWithoutTask');
      },
      ...overrides,
    };
    return { subscriber, log };
  }

  const moduleFor = (subscriber: SigningSubscriber, provider: Partial<SigningProvider> = {}) =>
    createSigningModule({
      provider: { ...createMockProvider(), ...provider },
      subscribers: { [FAKE.type]: subscriber },
      files: createLocalFileStore(dataDir),
      db: dbA(),
    });

  it('假的簽署標的沒有對應的合約，也能走完送簽、簽署、全員完成', async () => {
    const { subscriber, log } = fakeSubscriber();
    const signing = moduleFor(subscriber);

    await signing.send(FAKE, document, [signerA, signerB]);
    await signing.simulateEvent(FAKE, 'signed');
    await signing.simulateEvent(FAKE, 'signed');
    await signing.simulateEvent(FAKE, 'completed');

    expect(log).toEqual([['sent', 2], 'signer_signed', 'signer_signed', 'completed', 'afterCompleted']);
    await expect(signing.getProgress(FAKE)).resolves.toMatchObject({ status: 'completed' });
  });

  it('訂閱者失敗時，簽署進度一起回滾', async () => {
    const onOutcome = vi.fn<SigningSubscriber['onOutcome']>(async () => {
      throw new Error('訂閱者失敗');
    });
    const signing = moduleFor(fakeSubscriber({ onOutcome }).subscriber);
    await signing.send(FAKE, document, [signerA, signerB]);

    await expect(signing.simulateEvent(FAKE, 'signed')).rejects.toThrow('訂閱者失敗');

    const progress = await signing.getProgress(FAKE);
    expect(progress?.signers.map((s) => s.status)).toEqual(['pending', 'pending']);
  });

  it('送簽時訂閱者失敗，簽署任務不留下', async () => {
    const signing = moduleFor(
      fakeSubscriber({
        onSent: () => {
          throw new Error('訂閱者失敗');
        },
      }).subscriber
    );

    await expect(signing.send(FAKE, document, [signerA])).rejects.toThrow('訂閱者失敗');
    await expect(signing.getProgress(FAKE)).resolves.toBeNull();
  });

  it('完成後的處理失敗時，webhook 仍回 2xx，簽署進度維持完成', async () => {
    const signing = moduleFor(
      fakeSubscriber({
        afterCompleted: async () => {
          throw new Error('保存失敗');
        },
      }).subscriber,
      {
        createTask: async () => ({ taskRef: '470' }),
        parseWebhook: () => ({ kind: 'event', taskRef: '470', event: { type: 'completed' } }),
      }
    );
    await signing.send(FAKE, document, [signerA]);

    await expect(signing.ingestWebhook('{}', new Headers())).resolves.toEqual({ status: 200, body: { ok: true } });
    await expect(signing.getProgress(FAKE)).resolves.toMatchObject({ status: 'completed' });
  });

  it('webhook 對不到簽署任務時回 2xx，並記 log', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const signing = moduleFor(fakeSubscriber().subscriber, {
      parseWebhook: () => ({ kind: 'event', taskRef: 'no-such-task', event: { type: 'signed' } }),
    });

    await expect(signing.ingestWebhook('{}', new Headers())).resolves.toEqual({
      status: 200,
      body: { ok: true, ignored: true },
    });
    expect(info).toHaveBeenCalledWith(expect.stringContaining('no-such-task'));
    info.mockRestore();
  });

  it('訊息用訂閱者的名稱', async () => {
    const signing = moduleFor(fakeSubscriber().subscriber);
    await expect(signing.send({ ...FAKE, id: '1' }, document, [signerA])).rejects.toEqual(refusal(404, '撥款指示不存在'));
  });

  it('沒有訂閱者的簽署標的回 404，webhook 回 2xx 忽略', async () => {
    const signing = moduleFor(fakeSubscriber().subscriber, {
      createTask: async () => ({ taskRef: '470' }),
      parseWebhook: () => ({ kind: 'event', taskRef: '470', event: { type: 'completed' } }),
    });
    await signing.send(FAKE, document, [signerA]);

    await expect(signing.send({ type: 'unknown', id: '1' }, document, [signerA])).rejects.toEqual(
      refusal(404, '不支援的簽署標的')
    );
    const other = moduleFor({ ...fakeSubscriber().subscriber, exists: async () => false }, {
      parseWebhook: () => ({ kind: 'event', taskRef: '470', event: { type: 'completed' } }),
    });
    await expect(other.ingestWebhook('{}', new Headers())).resolves.toEqual({
      status: 200,
      body: { ok: true, ignored: true },
    });
  });
});

// 文件保存（MIL-58）：以簽署任務為鍵，完成的交易提交後保存，經簽署模組介面讀回。
describe('文件保存', () => {
  const completedWebhook = (taskRef = '470'): SigningProvider['parseWebhook'] => () => ({
    kind: 'event',
    taskRef,
    event: { type: 'completed' },
  });
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

  // 送簽後由 webhook 走到全員完成
  async function completeLive(provider: SigningProvider) {
    const subject = (await seed('draft'));
    const signing = moduleWith(provider);
    await signing.send(subject, document, signers);
    const ack = await signing.ingestWebhook('{}', new Headers());
    return { subject, signing, ack };
  }

  it('mock 送簽到全員完成，已簽 PDF 是送簽時的 PDF，沒有 Audit Trail File', async () => {
    const subject = (await seed('draft'));
    const signing = moduleWith();
    await signing.send(subject, document, signers);
    await signing.simulateEvent(subject, 'signed');
    await signing.simulateEvent(subject, 'completed');

    const files = await signing.listFiles(subject);
    expect(files.map((f) => [f.kind, f.status, f.file_name])).toEqual([
      ['signed_pdf', 'saved', `contract-${subject.id}-signed.pdf`],
    ]);
    const file = await signing.downloadFile(subject, 'signed_pdf');
    expect(file).toMatchObject({ fileName: `contract-${subject.id}-signed.pdf`, contentType: 'application/pdf' });
    expect(file.bytes).toEqual(document.pdf);
  });

  it('live 全員完成後保存兩份文件，記檔名、大小與狀態', async () => {
    const { subject, signing } = await completeLive(liveProvider({ parseWebhook: completedWebhook() }));
    expect((await statusOf(subject.id))).toBe('completed');

    const files = await signing.listFiles(subject);
    expect(files.map((f) => [f.kind, f.status, f.byte_size, f.error])).toEqual([
      ['audit_trail', 'saved', 'audit_trail-of-470'.length, null],
      ['signed_pdf', 'saved', 'signed_pdf-of-470'.length, null],
    ]);
    expect(text((await signing.downloadFile(subject, 'audit_trail')).bytes)).toBe('audit_trail-of-470');
  });

  it('保存在交易提交後才執行：下載時合約已是完成', async () => {
    let statusDuringDownload: ContractStatus | undefined;
    const provider = liveProvider({
      parseWebhook: completedWebhook(),
      downloadFile: async (_ref, kind) => {
        const { rows } = await inA((tx) => tx.query<{ id: string }>('SELECT id FROM org.contracts LIMIT 1'));
        statusDuringDownload = await statusOf(rows[0].id);
        return new TextEncoder().encode(kind);
      },
    });
    await completeLive(provider);
    expect(statusDuringDownload).toBe('completed');
  });

  it('保存失敗不回滾狀態，webhook 仍回 200，失敗原因記進文件紀錄', async () => {
    const provider = liveProvider({
      parseWebhook: completedWebhook(),
      downloadFile: async () => {
        throw new Error('點點簽 API 失敗（500）');
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { subject, signing, ack } = await completeLive(provider);

    expect(ack).toEqual({ status: 200, body: { ok: true } });
    expect((await statusOf(subject.id))).toBe('completed');
    expect((await signing.listFiles(subject)).map((f) => [f.kind, f.status, f.error])).toEqual([
      ['audit_trail', 'failed', '點點簽 API 失敗（500）'],
      ['signed_pdf', 'failed', '點點簽 API 失敗（500）'],
    ]);
  });

  it('保存的寫入本身失敗也不讓 webhook 回非 2xx', async () => {
    const provider = liveProvider({ parseWebhook: completedWebhook() });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const subject = (await seed('draft'));
    const signing = moduleWith(provider);
    await signing.send(subject, document, signers);
    await kit.asOwner((pg) =>
      pg.exec(`CREATE FUNCTION org.fail_files() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '寫入失敗'; END $$;
               CREATE TRIGGER fail_files BEFORE INSERT ON org.sign_task_files FOR EACH ROW EXECUTE FUNCTION org.fail_files();`),
    );

    await expect(signing.ingestWebhook('{}', new Headers())).resolves.toEqual({ status: 200, body: { ok: true } });
    expect((await statusOf(subject.id))).toBe('completed');
  });

  describe('補抓', () => {
    it('已保存的不重抓，強制時重抓', async () => {
      const downloadFile = vi.fn(async (_ref: string, kind: string) => new TextEncoder().encode(kind));
      const { subject, signing } = await completeLive(liveProvider({ parseWebhook: completedWebhook(), downloadFile }));
      expect(downloadFile).toHaveBeenCalledTimes(2);

      await expect(signing.saveFiles(subject)).resolves.toEqual([]);
      expect(downloadFile).toHaveBeenCalledTimes(2);

      await expect(signing.saveFiles(subject, { force: true })).resolves.toEqual([
        { kind: 'signed_pdf', ok: true },
        { kind: 'audit_trail', ok: true },
      ]);
      expect(downloadFile).toHaveBeenCalledTimes(4);
    });

    it('部分失敗時回每種文件的結果，成功的覆蓋先前的失敗紀錄', async () => {
      let failAll = true;
      const provider = liveProvider({
        parseWebhook: completedWebhook(),
        downloadFile: async (_ref, kind) => {
          if (failAll || kind === 'audit_trail') throw new Error('下載連結回應 403');
          return new TextEncoder().encode(kind);
        },
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { subject, signing } = await completeLive(provider);

      failAll = false;
      await expect(signing.saveFiles(subject, { force: true })).resolves.toEqual([
        { kind: 'signed_pdf', ok: true },
        { kind: 'audit_trail', ok: false, error: '下載連結回應 403' },
      ]);
      expect((await signing.listFiles(subject)).map((f) => [f.kind, f.status])).toEqual([
        ['audit_trail', 'failed'],
        ['signed_pdf', 'saved'],
      ]);
    });

    it('只補抓指定的種類', async () => {
      const downloadFile = vi.fn(async (_ref: string, kind: string) => new TextEncoder().encode(kind));
      const { subject, signing } = await completeLive(liveProvider({ parseWebhook: completedWebhook(), downloadFile }));
      await expect(signing.saveFiles(subject, { kinds: ['audit_trail'], force: true })).resolves.toEqual([
        { kind: 'audit_trail', ok: true },
      ]);
    });

    it('mock 模式不補抓 Audit Trail File', async () => {
      const subject = (await seed('draft'));
      const signing = moduleWith();
      await signing.send(subject, document, signers);
      await signing.simulateEvent(subject, 'completed');
      await expect(signing.saveFiles(subject, { force: true })).resolves.toEqual([{ kind: 'signed_pdf', ok: true }]);
    });

    it('未完成的合約回 409，訊息不變', async () => {
      const subject = (await seed('awaiting_tenant', '470'));
      await expect(moduleWith(liveProvider()).saveFiles(subject, { force: true })).rejects.toEqual(
        refusal(409, '合約尚未完成簽署，沒有可保存的文件')
      );
    });

    it('合約不存在回 404', async () => {
      await expect(moduleWith().saveFiles({ type: 'contract', id: ulidOf(999) })).rejects.toEqual(refusal(404, '合約不存在'));
    });

    it('已完成但沒有簽署任務時，每種文件都回失敗', async () => {
      const subject = (await seed('completed'));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(moduleWith(liveProvider()).saveFiles(subject, { force: true })).resolves.toEqual([
        { kind: 'signed_pdf', ok: false, error: '合約沒有對應的簽署任務' },
        { kind: 'audit_trail', ok: false, error: '合約沒有對應的簽署任務' },
      ]);
    });
  });

  describe('下載', () => {
    it.each(['signed_pdf', 'audit_trail'] as const)('未完成的合約下載 %s 回 409，訊息不變', async (kind) => {
      const label = kind === 'signed_pdf' ? '已簽 PDF' : 'Audit Trail File';
      for (const status of ['draft', 'awaiting_tenant', 'awaiting_landlord', 'declined', 'voided'] as const) {
        const subject = (await seed(status, status === 'draft' ? null : `t-${status}`));
        await expect(moduleWith(liveProvider()).downloadFile(subject, kind)).rejects.toEqual(
          refusal(409, `合約尚未完成簽署，${label}尚未產生`)
        );
      }
    });

    it('mock 模式下載 Audit Trail File 回 409，訊息不變', async () => {
      const subject = (await seed('completed', 'mock-1-abc'));
      await expect(moduleWith().downloadFile(subject, 'audit_trail')).rejects.toEqual(
        refusal(409, 'mock 模式沒有真實簽署任務，無法提供Audit Trail File')
      );
    });

    it('已完成但沒有簽署任務時回 409', async () => {
      const subject = (await seed('completed'));
      await expect(moduleWith(liveProvider()).downloadFile(subject, 'signed_pdf')).rejects.toEqual(
        refusal(409, '合約沒有對應的簽署任務，無法取得已簽 PDF')
      );
    });

    it('沒保存過時當場補抓一次', async () => {
      const subject = (await seed('completed', '470'));
      const downloadFile = vi.fn(async (ref: string, kind: string) => new TextEncoder().encode(`${kind}-of-${ref}`));
      const signing = moduleWith(liveProvider({ downloadFile }));

      expect(text((await signing.downloadFile(subject, 'signed_pdf')).bytes)).toBe('signed_pdf-of-470');
      expect(downloadFile.mock.calls).toEqual([['470', 'signed_pdf']]);
      expect((await signing.listFiles(subject)).map((f) => f.kind)).toEqual(['signed_pdf']);
    });

    it('檔案被刪掉時當場補抓一次', async () => {
      const downloadFile = vi.fn(async (_ref: string, kind: string) => new TextEncoder().encode(kind));
      const { subject, signing } = await completeLive(liveProvider({ parseWebhook: completedWebhook(), downloadFile }));
      fs.rmSync(path.join(dataDir, 'org'), { recursive: true, force: true });

      expect(text((await signing.downloadFile(subject, 'signed_pdf')).bytes)).toBe('signed_pdf');
      expect(downloadFile).toHaveBeenCalledTimes(3);
    });

    it('當場補抓失敗時回 502，帶失敗原因', async () => {
      const subject = (await seed('completed', '470'));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const provider = liveProvider({
        downloadFile: async () => {
          throw new Error('點點簽未回傳已簽 PDF的下載連結');
        },
      });
      await expect(moduleWith(provider).downloadFile(subject, 'signed_pdf')).rejects.toEqual(
        refusal(502, '取得已簽 PDF失敗：點點簽未回傳已簽 PDF的下載連結')
      );
    });

    it('合約不存在回 404', async () => {
      await expect(moduleWith().downloadFile({ type: 'contract', id: ulidOf(999) }, 'signed_pdf')).rejects.toEqual(
        refusal(404, '合約不存在')
      );
    });
  });

  it('沒有簽署任務時文件清單是空的', async () => {
    await expect(moduleWith().listFiles((await seed('completed')))).resolves.toEqual([]);
  });
});

describe('signingErrorResponse', () => {
  it('SigningRefusal 回它的狀態碼與訊息', async () => {
    const res = signingErrorResponse(new SigningRefusal(409, 'mock 模式不寄信'), '重寄通知失敗');
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: 'mock 模式不寄信' });
  });

  it('其他 Error 回 502 與原訊息', async () => {
    const res = signingErrorResponse(new Error('點點簽 API 失敗（500）'), '重寄通知失敗');
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({ error: '點點簽 API 失敗（500）' });
  });

  it('不是 Error 時回 502 與預設訊息', async () => {
    const res = signingErrorResponse('boom', '重寄通知失敗');
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({ error: '重寄通知失敗' });
  });
});
