import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createContractSubscriber } from '../contract-signing';
import { createLocalFileStore } from '../file-store/local-file-store';
import { withTx } from '../pg/database';
import { setupRouteDb, type RouteDb } from '../pg/route-test-kit';
import { ulidOf } from '../test-ids';
import type { OrgTx } from '../pg/with-tx';
import type { SigningDb } from './db';
import { createMockProvider } from './mock-adapter';
import { createSigningModule } from './module';
import type { SigningSubject } from './provider';
import { findSignTasks, insertSignTask, signingSubjectKey } from './sign-task-store';

// 清單批次查簽署進度（MIL-72）：一次查詢取回整頁合約的進度，查詢次數與合約數量無關。
// 資料庫是 PGlite（MIL-85）：`= ANY` 批次查詢，別的組織的簽署任務靠 RLS 篩掉。

let kit: RouteDb;
let dataDir: string;

beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());

beforeEach(async () => {
  await kit.reset();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signing-batch-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const inA = <T,>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: kit.orgA }, fn);
const inB = <T,>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: kit.orgB }, fn);

const subject = (id: number, type = 'contract'): SigningSubject => ({ type, id: ulidOf(id) });

/** 包一層交易，數 query 呼叫次數。 */
function counted(tx: OrgTx): { tx: OrgTx; count: () => number } {
  let n = 0;
  const wrapped = {
    kind: tx.kind,
    query: (...args: Parameters<OrgTx['query']>) => {
      n += 1;
      return tx.query(...args);
    },
  } as OrgTx;
  return { tx: wrapped, count: () => n };
}

type SeedSigner = { role: 'party_a' | 'party_b' | 'practitioner'; concurrentRoles?: ('party_a' | 'party_b')[] };

function seedTask(
  tx: OrgTx,
  id: number,
  signers: SeedSigner[],
  options: { type?: string; taskRef?: string } = {},
): Promise<boolean> {
  return insertSignTask(tx, {
    provider: 'mock',
    taskRef: options.taskRef ?? `ref-${options.type ?? 'contract'}-${id}`,
    subject: subject(id, options.type),
    signers: signers.map((s, i) => ({ ...s, name: `簽署人${id}-${i}`, email: `s${id}-${i}@example.com` })),
  });
}

const seedMany = (ids: number[], signers: SeedSigner[]) =>
  inA(async (tx) => {
    for (const id of ids) await seedTask(tx, id, signers);
  });

describe('findSignTasks：批次查簽署任務', () => {
  it('一次取回多份合約的簽署任務與簽署人，順序與兼任角色都在', async () => {
    await inA(async (tx) => {
      await seedTask(tx, 1, [{ role: 'party_b' }, { role: 'party_a' }]);
      await seedTask(tx, 2, [{ role: 'party_b' }, { role: 'practitioner', concurrentRoles: ['party_a'] }]);
    });
    const tasks = await inA((tx) => findSignTasks(tx, [subject(1), subject(2), subject(3)]));

    expect([...tasks.keys()].sort()).toEqual([signingSubjectKey(subject(1)), signingSubjectKey(subject(2))]);
    expect(tasks.get(signingSubjectKey(subject(1)))?.signers.map((s) => s.role)).toEqual(['party_b', 'party_a']);
    const merged = tasks.get(signingSubjectKey(subject(2)))?.signers[1];
    expect(merged).toMatchObject({ role: 'practitioner', concurrentRoles: ['party_a'] });
  });

  it('沒有簽署任務的合約不在結果裡，空清單不查詢', async () => {
    await inA(async (tx) => {
      const { tx: spy, count } = counted(tx);
      expect((await findSignTasks(spy, [])).size).toBe(0);
      expect(count()).toBe(0);
      expect((await findSignTasks(spy, [subject(99)])).size).toBe(0);
    });
  });

  it('只取指定的簽署標的：種類不同、編號相同的任務不混進來', async () => {
    await inA(async (tx) => {
      await seedTask(tx, 1, [{ role: 'party_b' }]);
      await seedTask(tx, 1, [{ role: 'party_a' }], { type: 'handover_certificate' });
    });
    const tasks = await inA((tx) => findSignTasks(tx, [subject(1)]));
    expect(tasks.size).toBe(1);
    expect(tasks.get(signingSubjectKey(subject(1)))?.signers[0].name).toBe('簽署人1-0');
  });

  it('同一個簽署標的重複出現時只算一次', async () => {
    await seedMany([1], [{ role: 'party_b' }]);
    const tasks = await inA((tx) => findSignTasks(tx, [subject(1), subject(1)]));
    expect(tasks.size).toBe(1);
  });

  it('別的組織的簽署任務查不到：RLS 篩掉，和不存在一樣', async () => {
    await inB(async (tx) => {
      await seedTask(tx, 1, [{ role: 'party_b' }]);
    });
    await seedMany([2], [{ role: 'party_b' }]);
    const tasks = await inA((tx) => findSignTasks(tx, [subject(1), subject(2)]));
    expect([...tasks.keys()]).toEqual([signingSubjectKey(subject(2))]);
  });

  it('查詢次數與合約數量無關：3 份與 60 份都是 2 次', async () => {
    await seedMany(Array.from({ length: 60 }, (_, i) => i + 1), [{ role: 'party_b' }, { role: 'party_a' }]);
    const countQueries = (ids: number[]) =>
      inA(async (tx) => {
        const { tx: spy, count } = counted(tx);
        await findSignTasks(spy, ids.map((id) => subject(id)));
        return count();
      });
    expect(await countQueries([1, 2, 3])).toBe(2);
    expect(await countQueries(Array.from({ length: 60 }, (_, i) => i + 1))).toBe(2);
  });
});

describe('signing.getProgressBatch：簽署模組的批次介面', () => {
  const dbA = (onQuery?: () => void): SigningDb => ({
    requestOrg: async () => ({ kind: 'org', orgId: kit.orgA }),
    inOrg: (ctx, fn) =>
      withTx(ctx, (tx) => {
        if (!onQuery) return fn(tx);
        return fn({
          kind: tx.kind,
          query: (...args: Parameters<OrgTx['query']>) => {
            onQuery();
            return tx.query(...args);
          },
        } as OrgTx);
      }),
    inControl: (fn) => withTx({ kind: 'control' }, fn),
  });
  const moduleWith = (onQuery?: () => void) =>
    createSigningModule({
      provider: createMockProvider(),
      subscribers: { contract: createContractSubscriber() },
      files: createLocalFileStore(dataDir),
      db: dbA(onQuery),
    });

  it('回傳以簽署標的為鍵的簽署進度，含當前簽署人', async () => {
    await inA(async (tx) => {
      await seedTask(tx, 1, [{ role: 'party_b' }, { role: 'party_a' }]);
      await seedTask(tx, 2, [{ role: 'party_b' }, { role: 'practitioner' }, { role: 'party_a' }]);
    });
    const batch = await moduleWith().getProgressBatch([subject(1), subject(2), subject(3)]);

    expect([...batch.keys()].sort()).toEqual([signingSubjectKey(subject(1)), signingSubjectKey(subject(2))]);
    expect(batch.get(signingSubjectKey(subject(2)))).toMatchObject({
      status: 'in_progress',
      currentSigner: { role: 'party_b' },
    });
  });

  it('與逐筆查詢的 getProgress 結果相同', async () => {
    await inA((tx) => seedTask(tx, 1, [{ role: 'party_b' }, { role: 'practitioner', concurrentRoles: ['party_a'] }]));
    const signing = moduleWith();
    const batch = await signing.getProgressBatch([subject(1)]);
    expect(batch.get(signingSubjectKey(subject(1)))).toEqual(await signing.getProgress(subject(1)));
  });

  it('整頁 60 份合約只查 2 次', async () => {
    await seedMany(Array.from({ length: 60 }, (_, i) => i + 1), [{ role: 'party_b' }, { role: 'party_a' }]);
    let queries = 0;
    await moduleWith(() => (queries += 1)).getProgressBatch(Array.from({ length: 60 }, (_, i) => subject(i + 1)));
    expect(queries).toBe(2);
  });
});
