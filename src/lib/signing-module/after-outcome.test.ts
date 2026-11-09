import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContractSubscriber } from '../contract-signing';
import { createContract, getContract } from '../contracts';
import { createLocalFileStore } from '../file-store/local-file-store';
import { withTx } from '../pg/database';
import { actAs, setupRouteDb, type RouteDb } from '../pg/route-test-kit';
import type { OrgTx } from '../pg/with-tx';
import type { ContractFields } from '../types';
import type { SigningDb } from './db';
import { createMockProvider } from './mock-adapter';
import { createSigningModule } from './module';
import type { SignableDocument, Signer } from './provider';
import type { SigningSubscriber } from './subscriber';

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));

// afterOutcome 掛鉤的契約（MIL-75）：每個被接受的簽署事件在交易提交後呼叫，例外不往外拋。
// 資料庫是 PGlite（第二次同步 main 時由 SQLite 改寫，斷言內容不變）。

let kit: RouteDb;
let dataDir: string;

beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());

beforeEach(async () => {
  await kit.reset();
  actAs(kit.orgA);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'after-outcome-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const inA = <T,>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: kit.orgA }, fn);
const statusOf = async (id: string) => (await inA((tx) => getContract(tx, id)))?.status;

// withTx 不得巢狀：afterOutcome 被呼叫時如果模組還開著交易，再開一個會丟錯。
// 能開成功，就代表呼叫當下沒有任何交易（這是 SQLite 版 db.inTransaction 為 false 的對應斷言）
const insideTransaction = () =>
  inA(async () => false).catch((e: unknown) => {
    if (e instanceof Error && e.message.includes('不得巢狀')) return true;
    throw e;
  });

const dbForA = (): SigningDb => ({
  requestOrg: async () => ({ kind: 'org', orgId: kit.orgA }),
  inOrg: (ctx, fn) => withTx(ctx, fn),
  inControl: (fn) => withTx({ kind: 'control' }, fn),
});

const document: SignableDocument = {
  fileName: '租賃合約-測試物件',
  pdf: new Uint8Array([37, 80, 68, 70]),
  pageSize: { width: 595.28, height: 841.89 },
};
const signers: Signer[] = [
  { role: 'party_b', name: '王租客', email: 'tenant@example.com', signatureFields: [] },
  { role: 'party_a', name: '林房東', email: 'landlord@example.com', signatureFields: [] },
];

async function setup(afterOutcome: NonNullable<SigningSubscriber['afterOutcome']>) {
  const id = await inA((tx) =>
    createContract(tx, {
      property_id: null,
      fields: {
        landlordName: '林房東',
        landlordEmail: 'landlord@example.com',
        tenantName: '王租客',
        tenantEmail: 'tenant@example.com',
      } as ContractFields,
    }),
  );
  const subject = { type: 'contract', id } as const;
  const signing = createSigningModule({
    provider: createMockProvider(),
    subscribers: { contract: { ...createContractSubscriber(), afterOutcome } },
    files: createLocalFileStore(dataDir),
    db: dbForA(),
  });
  await signing.send(subject, document, signers);
  return { signing, subject };
}

describe('afterOutcome', () => {
  it('每個被接受的事件在交易提交後呼叫一次，帶結果，不在交易內', async () => {
    const calls: Array<{ type: string; inTransaction: boolean; status: string | undefined }> = [];
    const { signing, subject } = await setup(async (s, outcome) => {
      calls.push({ type: outcome.type, inTransaction: await insideTransaction(), status: await statusOf(s.id) });
    });
    await signing.simulateEvent(subject, 'signed');
    await signing.simulateEvent(subject, 'completed');

    expect(calls).toEqual([
      { type: 'signer_signed', inTransaction: false, status: 'awaiting_landlord' },
      { type: 'completed', inTransaction: false, status: 'completed' },
    ]);
  });

  it('不接受的事件不呼叫', async () => {
    const afterOutcome = vi.fn(async () => {});
    const { signing, subject } = await setup(afterOutcome);
    await signing.simulateEvent(subject, 'completed');
    afterOutcome.mockClear();
    await expect(signing.simulateEvent(subject, 'signed')).rejects.toThrow();
    expect(afterOutcome).not.toHaveBeenCalled();
  });

  it('例外只記 log：webhook 與簽署進度不受影響', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { signing, subject } = await setup(async () => {
      throw new Error('後續處理失敗');
    });
    await expect(signing.simulateEvent(subject, 'signed')).resolves.toEqual({ status: 'awaiting_landlord' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('後續處理失敗'));
  });

  it('tools.voidTask 與手動撤回走同一條路徑：撤回事件再呼叫 afterOutcome', async () => {
    const seen: string[] = [];
    const { signing, subject } = await setup(async (_s, outcome, tools) => {
      seen.push(outcome.type);
      if (outcome.type === 'signer_signed') await tools.voidTask();
    });
    await signing.simulateEvent(subject, 'signed');
    expect(await statusOf(subject.id)).toBe('voided');
    expect(seen).toEqual(['signer_signed', 'voided']);
  });

  it('全員完成時，afterOutcome 在 afterCompleted 之後呼叫', async () => {
    const order: string[] = [];
    const id = await inA((tx) =>
      createContract(tx, {
        property_id: null,
        fields: { landlordName: '林房東', landlordEmail: 'landlord@example.com', tenantName: '王租客', tenantEmail: 'tenant@example.com' } as ContractFields,
      }),
    );
    const subject = { type: 'contract', id } as const;
    const base = createContractSubscriber();
    const signing = createSigningModule({
      provider: createMockProvider(),
      subscribers: {
        contract: {
          ...base,
          afterCompleted: async () => void order.push('afterCompleted'),
          afterOutcome: async (_s, outcome) => void order.push(`afterOutcome:${outcome.type}`),
        },
      },
      files: createLocalFileStore(dataDir),
      db: dbForA(),
    });
    await signing.send(subject, document, signers);
    await signing.simulateEvent(subject, 'signed');
    await signing.simulateEvent(subject, 'completed');
    expect(order).toEqual(['afterOutcome:signer_signed', 'afterCompleted', 'afterOutcome:completed']);
  });

  it('tools.inOrg 在事件所屬組織開一個獨立的交易，能讀到已提交的合約', async () => {
    const seen: Array<string | undefined> = [];
    const { signing, subject } = await setup(async (s, _outcome, tools) => {
      seen.push(await tools.inOrg(async (tx) => (await getContract(tx, s.id))?.status));
    });
    await signing.simulateEvent(subject, 'signed');
    expect(seen).toEqual(['awaiting_landlord']);
  });
});
