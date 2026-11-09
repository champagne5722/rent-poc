import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContractSubscriber } from '../contract-signing';
import { ensureSchema, getContract, setDb } from '../db';
import { createMockProvider } from './mock-adapter';
import { createSigningModule } from './module';
import type { SignableDocument, Signer } from './provider';
import type { SigningSubscriber } from './subscriber';

// afterOutcome 掛鉤的契約（MIL-75）：每個被接受的簽署事件在交易提交後呼叫，例外不往外拋。

let db: Database.Database;
let dataDir: string;

beforeEach(() => {
  db = new Database(':memory:');
  ensureSchema(db);
  setDb(db);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'after-outcome-'));
});

afterEach(() => {
  setDb(null);
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
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
  const result = db
    .prepare('INSERT INTO contracts (property_id, status, fields) VALUES (NULL, ?, ?)')
    .run('draft', JSON.stringify({ landlordName: '林房東', landlordEmail: 'landlord@example.com', tenantName: '王租客', tenantEmail: 'tenant@example.com' }));
  const subject = { type: 'contract', id: Number(result.lastInsertRowid) } as const;
  const signing = createSigningModule({
    provider: createMockProvider(),
    subscribers: { contract: { ...createContractSubscriber(), afterOutcome } },
    dataDir,
  });
  await signing.send(subject, document, signers);
  return { signing, subject };
}

describe('afterOutcome', () => {
  it('每個被接受的事件在交易提交後呼叫一次，帶結果，不在交易內', async () => {
    const calls: Array<{ type: string; inTransaction: boolean; status: string }> = [];
    const { signing, subject } = await setup(async (s, outcome) => {
      calls.push({ type: outcome.type, inTransaction: db.inTransaction, status: getContract(s.id)!.status });
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
    expect(getContract(subject.id)?.status).toBe('voided');
    expect(seen).toEqual(['signer_signed', 'voided']);
  });
});
