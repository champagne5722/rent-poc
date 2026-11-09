import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContractSubscriber } from '../contract-signing';
import { ensureSchema, setDb } from '../db';
import { createMockProvider } from './mock-adapter';
import { createSigningModule } from './module';
import type { SigningSubject } from './provider';
import { ensureSignTaskTables, findSignTasks, insertSignTask, signingSubjectKey } from './sign-task-store';

// 清單批次查簽署進度（MIL-72）：一次查詢取回整頁合約的進度，查詢次數與合約數量無關。

let db: Database.Database;
let dataDir: string;

beforeEach(() => {
  db = new Database(':memory:');
  ensureSchema(db);
  ensureSignTaskTables(db);
  setDb(db);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signing-batch-'));
});

afterEach(() => {
  setDb(null);
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const subject = (id: number): SigningSubject => ({ type: 'contract', id });

function seedTask(id: number, signers: { role: 'party_a' | 'party_b' | 'practitioner'; concurrentRoles?: ('party_a' | 'party_b')[] }[]) {
  insertSignTask(db, {
    provider: 'mock',
    taskRef: `ref-${id}`,
    subject: subject(id),
    signers: signers.map((s, i) => ({ ...s, name: `簽署人${id}-${i}`, email: `s${id}-${i}@example.com` })),
  });
}

describe('findSignTasks：批次查簽署任務', () => {
  it('一次取回多份合約的簽署任務與簽署人，順序與兼任角色都在', () => {
    seedTask(1, [{ role: 'party_b' }, { role: 'party_a' }]);
    seedTask(2, [{ role: 'party_b' }, { role: 'practitioner', concurrentRoles: ['party_a'] }]);
    const tasks = findSignTasks(db, [subject(1), subject(2), subject(3)]);

    expect([...tasks.keys()].sort()).toEqual([signingSubjectKey(subject(1)), signingSubjectKey(subject(2))]);
    expect(tasks.get(signingSubjectKey(subject(1)))?.signers.map((s) => s.role)).toEqual(['party_b', 'party_a']);
    const merged = tasks.get(signingSubjectKey(subject(2)))?.signers[1];
    expect(merged).toMatchObject({ role: 'practitioner', concurrentRoles: ['party_a'] });
  });

  it('沒有簽署任務的合約不在結果裡，空清單不查詢', () => {
    const prepare = vi.spyOn(db, 'prepare');
    expect(findSignTasks(db, []).size).toBe(0);
    expect(prepare).not.toHaveBeenCalled();
    expect(findSignTasks(db, [subject(99)]).size).toBe(0);
  });

  it('只取指定的簽署標的：種類不同、編號相同的任務不混進來', () => {
    seedTask(1, [{ role: 'party_b' }]);
    insertSignTask(db, {
      provider: 'mock',
      taskRef: 'ref-other',
      subject: { type: 'handover_certificate', id: 1 },
      signers: [{ role: 'party_a', name: '別種標的', email: 'x@example.com' }],
    });
    const tasks = findSignTasks(db, [subject(1)]);
    expect(tasks.size).toBe(1);
    expect(tasks.get(signingSubjectKey(subject(1)))?.signers[0].name).toBe('簽署人1-0');
  });

  it('查詢次數與合約數量無關：3 份與 60 份都是 2 次', () => {
    for (let id = 1; id <= 60; id++) seedTask(id, [{ role: 'party_b' }, { role: 'party_a' }]);
    const countPrepares = (ids: number[]) => {
      const prepare = vi.spyOn(db, 'prepare');
      findSignTasks(db, ids.map(subject));
      const n = prepare.mock.calls.length;
      prepare.mockRestore();
      return n;
    };
    expect(countPrepares([1, 2, 3])).toBe(2);
    expect(countPrepares(Array.from({ length: 60 }, (_, i) => i + 1))).toBe(2);
  });
});

describe('signing.getProgressBatch：簽署模組的批次介面', () => {
  const moduleWith = () =>
    createSigningModule({ provider: createMockProvider(), subscribers: { contract: createContractSubscriber() }, dataDir });

  it('回傳以簽署標的為鍵的簽署進度，含當前簽署人', async () => {
    seedTask(1, [{ role: 'party_b' }, { role: 'party_a' }]);
    seedTask(2, [{ role: 'party_b' }, { role: 'practitioner' }, { role: 'party_a' }]);
    const batch = await moduleWith().getProgressBatch([subject(1), subject(2), subject(3)]);

    expect([...batch.keys()].sort()).toEqual([signingSubjectKey(subject(1)), signingSubjectKey(subject(2))]);
    expect(batch.get(signingSubjectKey(subject(2)))).toMatchObject({
      status: 'in_progress',
      currentSigner: { role: 'party_b' },
    });
  });

  it('與逐筆查詢的 getProgress 結果相同', async () => {
    seedTask(1, [{ role: 'party_b' }, { role: 'practitioner', concurrentRoles: ['party_a'] }]);
    const signing = moduleWith();
    const batch = await signing.getProgressBatch([subject(1)]);
    expect(batch.get(signingSubjectKey(subject(1)))).toEqual(await signing.getProgress(subject(1)));
  });

  it('整頁 60 份合約只查 2 次', async () => {
    for (let id = 1; id <= 60; id++) seedTask(id, [{ role: 'party_b' }, { role: 'party_a' }]);
    const prepare = vi.spyOn(db, 'prepare');
    await moduleWith().getProgressBatch(Array.from({ length: 60 }, (_, i) => subject(i + 1)));
    expect(prepare).toHaveBeenCalledTimes(2);
  });
});
