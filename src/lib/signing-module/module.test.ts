import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureSchema, getContract, listContractEvents, setDb } from '../db';
import type { Contract, ContractStatus } from '../types';
import { createMockProvider } from './mock-adapter';
import { createSigningModule, signingErrorResponse, SigningRefusal } from './module';
import type { SignableDocument, Signer, SigningProvider } from './provider';

let db: Database.Database;
let onCompleted: ReturnType<typeof vi.fn<(contract: Contract) => Promise<void>>>;

beforeEach(() => {
  db = new Database(':memory:');
  ensureSchema(db);
  setDb(db);
  onCompleted = vi.fn(async () => {});
});

afterEach(() => {
  setDb(null);
  db.close();
});

const FIELDS = JSON.stringify({
  landlordName: '林房東',
  landlordEmail: 'landlord@example.com',
  tenantName: '王租客',
  tenantEmail: 'tenant@example.com',
});

function seed(status: ContractStatus, taskRef: string | null = null) {
  const result = db
    .prepare('INSERT INTO contracts (property_id, status, fields, dottedsign_task_id) VALUES (NULL, ?, ?, ?)')
    .run(status, FIELDS, taskRef);
  return { type: 'contract', id: Number(result.lastInsertRowid) } as const;
}

const moduleWith = (provider: SigningProvider = createMockProvider()) => createSigningModule({ provider, onCompleted });

const statusOf = (id: number) => getContract(id)?.status;
const eventTypes = (id: number) => listContractEvents(id, db).map((e) => e.type);

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
  mode: 'live',
  unsupported: { simulate: 'live 模式下請走真實 webhook' },
  createTask: async () => ({ taskRef: '470' }),
  getSignLink: async () => 'https://sign.example/abc',
  resend: async () => {},
  voidTask: async () => {},
  parseWebhook: () => ({ kind: 'ignored' }),
  ...overrides,
});

const refusal = (status: number, message: string) => expect.objectContaining({ name: 'SigningRefusal', status, message });

describe('送簽', () => {
  it('回傳平台的簽署任務，合約進入待乙方簽並記送簽歷程', async () => {
    const subject = seed('draft');
    const task = await moduleWith().send(subject, document, signers);

    expect(task).toEqual({ subject, mode: 'mock' });
    expect(statusOf(subject.id)).toBe('awaiting_tenant');
    expect(getContract(subject.id)?.dottedsign_task_id).toMatch(new RegExp(`^mock-${subject.id}-`));
    expect(listContractEvents(subject.id, db).map((e) => [e.type, e.actor, e.note])).toEqual([
      ['sent', 'landlord', '寄送給乙方 tenant@example.com'],
    ]);
  });

  it('live 模式的簽署任務帶 live', async () => {
    const task = await moduleWith(liveProvider()).send(seed('draft'), document, signers);
    expect(task.mode).toBe('live');
  });

  it('服務商建立任務失敗時，合約維持草稿，不記歷程', async () => {
    const subject = seed('draft');
    const provider = liveProvider({
      createTask: async () => {
        throw new Error('點點簽 API 失敗（500）');
      },
    });
    await expect(moduleWith(provider).send(subject, document, signers)).rejects.toThrow('點點簽 API 失敗（500）');
    expect(statusOf(subject.id)).toBe('draft');
    expect(eventTypes(subject.id)).toEqual([]);
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
    const subject = seed('awaiting_tenant', 'task-1');
    await expect(moduleWith().ingestWebhook(webhook('task-1', 'viewed'), new Headers())).resolves.toEqual({
      status: 200,
      body: { ok: true, ignored: true },
    });
    expect(statusOf(subject.id)).toBe('awaiting_tenant');
  });

  it('找不到對應合約時回 200 ignored', async () => {
    await expect(moduleWith().ingestWebhook(webhook('no-such-task', 'signed'), new Headers())).resolves.toEqual({
      status: 200,
      body: { ok: true, ignored: true },
    });
  });

  it('走完乙方簽署到全員完成：狀態、歷程都推進，完成後保存文件一次', async () => {
    const subject = seed('awaiting_tenant', 'task-1');
    const signing = moduleWith();

    await expect(signing.ingestWebhook(webhook('task-1', 'signed'), new Headers())).resolves.toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(statusOf(subject.id)).toBe('awaiting_landlord');
    expect(onCompleted).not.toHaveBeenCalled();

    await signing.ingestWebhook(webhook('task-1', 'completed'), new Headers());
    expect(statusOf(subject.id)).toBe('completed');
    expect(eventTypes(subject.id)).toEqual(['tenant_signed', 'completed']);
    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(onCompleted.mock.calls[0][0].id).toBe(subject.id);
  });

  it('重複的 completed 回 200，不再推進，也不再保存文件', async () => {
    const subject = seed('awaiting_landlord', 'task-1');
    const signing = moduleWith();
    await signing.ingestWebhook(webhook('task-1', 'completed'), new Headers());
    await expect(signing.ingestWebhook(webhook('task-1', 'completed'), new Headers())).resolves.toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(eventTypes(subject.id)).toEqual(['completed']);
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });

  it('拒簽原因寫進合約與歷程附註', async () => {
    const subject = seed('awaiting_tenant', 'task-1');
    await moduleWith().ingestWebhook(webhook('task-1', 'declined', { reason: '租金認知有落差' }), new Headers());
    expect(getContract(subject.id)).toMatchObject({ status: 'declined', declined_reason: '租金認知有落差' });
    expect(listContractEvents(subject.id, db)[0]).toMatchObject({ type: 'declined', note: '租金認知有落差' });
  });
});

describe('模擬簽署事件（mock advance）', () => {
  it('mock 模式能推進到完成，回傳下一狀態，完成後保存文件', async () => {
    const subject = seed('awaiting_tenant', 'mock-1-abc');
    const signing = moduleWith();
    await expect(signing.simulateEvent(subject, 'signed')).resolves.toEqual({ status: 'awaiting_landlord' });
    await expect(signing.simulateEvent(subject, 'completed')).resolves.toEqual({ status: 'completed' });
    expect(eventTypes(subject.id)).toEqual(['tenant_signed', 'completed']);
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });

  it('拒簽原因會傳進歷程', async () => {
    const subject = seed('awaiting_tenant', 'mock-1-abc');
    await moduleWith().simulateEvent(subject, 'declined', '想再考慮');
    expect(listContractEvents(subject.id, db)[0]).toMatchObject({ type: 'declined', note: '想再考慮' });
  });

  it('live 模式回 403，訊息不變', async () => {
    const subject = seed('awaiting_tenant', '470');
    await expect(moduleWith(liveProvider()).simulateEvent(subject, 'signed')).rejects.toEqual(
      refusal(403, 'live 模式下請走真實 webhook')
    );
    expect(statusOf(subject.id)).toBe('awaiting_tenant');
  });

  it('合約不存在回 404', async () => {
    await expect(moduleWith().simulateEvent({ type: 'contract', id: 999 }, 'signed')).rejects.toEqual(
      refusal(404, '合約不存在')
    );
  });

  it.each(['voided', 'viewed', undefined])('不支援的事件 %s 回 400', async (event) => {
    await expect(moduleWith().simulateEvent(seed('awaiting_tenant', 'mock-1-abc'), event)).rejects.toEqual(
      refusal(400, '不支援的事件')
    );
  });

  it('狀態不接受時回 409，訊息帶目前狀態', async () => {
    await expect(moduleWith().simulateEvent(seed('draft'), 'signed')).rejects.toEqual(
      refusal(409, '目前狀態（draft）不接受此事件')
    );
  });
});

describe('取簽署連結', () => {
  const redirect = 'https://app.example/contracts/1';

  it('回傳當前簽署人與連結，連結對應當前簽署人的 email', async () => {
    const subject = seed('awaiting_landlord', '470');
    const getSignLink = vi.fn(async () => 'https://sign.example/abc');
    await expect(moduleWith(liveProvider({ getSignLink })).getSignLink(subject, redirect)).resolves.toEqual({
      signer: { role: 'party_a', name: '林房東', email: 'landlord@example.com' },
      url: 'https://sign.example/abc',
    });
    expect(getSignLink).toHaveBeenCalledWith('470', 'landlord@example.com', redirect);
  });

  it('mock 模式回 409，即使合約不在簽署中也先回 mock 訊息', async () => {
    await expect(moduleWith().getSignLink(seed('draft'), redirect)).rejects.toEqual(
      refusal(409, 'mock 模式無簽署連結')
    );
  });

  it.each([
    ['不在簽署中', 'draft', '470'],
    ['沒有任務編號', 'awaiting_tenant', null],
  ] as const)('%s回 409', async (_label, status, taskRef) => {
    await expect(moduleWith(liveProvider()).getSignLink(seed(status, taskRef), redirect)).rejects.toEqual(
      refusal(409, '合約不在簽署中，沒有待簽方')
    );
  });

  it('合約不存在回 404', async () => {
    await expect(moduleWith(liveProvider()).getSignLink({ type: 'contract', id: 999 }, redirect)).rejects.toEqual(
      refusal(404, '合約不存在')
    );
  });
});

describe('重寄', () => {
  it('回傳當前簽署人', async () => {
    const subject = seed('awaiting_tenant', '470');
    const resend = vi.fn(async () => {});
    await expect(moduleWith(liveProvider({ resend })).resend(subject)).resolves.toEqual({
      signer: { role: 'party_b', name: '王租客', email: 'tenant@example.com' },
    });
    expect(resend).toHaveBeenCalledWith('470');
  });

  it('mock 模式回 409，即使合約不在簽署中也先回 mock 訊息', async () => {
    await expect(moduleWith().resend(seed('draft'))).rejects.toEqual(refusal(409, 'mock 模式不寄信'));
  });

  it('不在簽署中回 409', async () => {
    await expect(moduleWith(liveProvider()).resend(seed('completed', '470'))).rejects.toEqual(
      refusal(409, '合約不在簽署中，沒有待簽方')
    );
  });
});

describe('撤回', () => {
  it('撤回服務商任務，合約進入已撤回並記歷程', async () => {
    const subject = seed('awaiting_landlord', '470');
    const voidTask = vi.fn(async () => {});
    await expect(moduleWith(liveProvider({ voidTask })).voidTask(subject)).resolves.toBeUndefined();
    expect(voidTask).toHaveBeenCalledWith('470');
    expect(statusOf(subject.id)).toBe('voided');
    expect(eventTypes(subject.id)).toEqual(['voided']);
  });

  it('簽署中但沒有任務編號時，不呼叫服務商，仍能撤回', async () => {
    const subject = seed('awaiting_tenant');
    const voidTask = vi.fn(async () => {});
    await moduleWith(liveProvider({ voidTask })).voidTask(subject);
    expect(voidTask).not.toHaveBeenCalled();
    expect(statusOf(subject.id)).toBe('voided');
  });

  it('mock 模式也能撤回', async () => {
    const subject = seed('awaiting_tenant', 'mock-1-abc');
    await moduleWith().voidTask(subject);
    expect(statusOf(subject.id)).toBe('voided');
  });

  it('不在簽署中回 409', async () => {
    await expect(moduleWith().voidTask(seed('draft'))).rejects.toEqual(refusal(409, '僅簽署中的合約可撤回'));
  });

  it('服務商撤回失敗時，合約維持簽署中', async () => {
    const subject = seed('awaiting_tenant', '470');
    const provider = liveProvider({
      voidTask: async () => {
        throw new Error('點點簽 API 失敗（403）');
      },
    });
    await expect(moduleWith(provider).voidTask(subject)).rejects.toThrow('點點簽 API 失敗（403）');
    expect(statusOf(subject.id)).toBe('awaiting_tenant');
    expect(eventTypes(subject.id)).toEqual([]);
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
