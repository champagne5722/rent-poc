import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withCaseMemberTx } from '../case-store';
import { useTxDriver } from '../pg/database';
import { pgliteDriver } from '../pg/drivers';
import { asRole, createTestDb, type TestDb } from '../pg/test-harness';
import { newUlid } from '../pg/ulid';
import { createWithTx, type Tx, type WithTx } from '../pg/with-tx';
import { getSignTaskFile, listSignTaskFiles } from './sign-task-files';
import { findSignTask, findSignTaskByRef, findSignTasks } from './sign-task-store';

// sign-task-store 的查詢必須明確帶 org_id（MIL-89，MIL-115 的待辦）。
// 案件成員政策讓出租人在自己的組織脈絡下，也讀得到另一個組織（主辦組織）的簽署任務。
// 只靠 RLS 篩選時，用主辦組織的簽署標的 ID 查詢，會讀到不屬於目前組織的簽署任務。

// 正當的跨組織讀取不經過這些函式（MIL-89 的結論）：
// - 承租人端（party 脈絡）用 src/lib/tenant/queries.ts 的專屬 SQL，自己 JOIN 並帶 org_id，測試在 tenant-cases.test.ts。
// - 別的組織的案件成員寫入或讀取，走 withCaseMemberTx：第 3 步把交易的 app.org_id 設成案件所在的組織，條件成立。
// - 表層的成員讀取政策（每種關係讀得到哪些表）沒有動，測試在 case-rls.test.ts 的成員讀取矩陣。
// 這個檔案證明前兩者不受影響，與函式自己的組織脈絡才是唯一的讀取範圍。
let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(() => testDb.close());

describe('簽署任務的查詢只看目前組織的列', () => {
  let withTx: WithTx;
  const host = newUlid(); // 主辦組織：案件與簽署任務在這裡
  const mine = newUlid(); // 出租人自己的組織：沒有這個簽署任務
  const lessor = newUlid(); // 主辦組織案件的出租人成員，同時在 mine 工作
  const contractId = newUlid();
  const taskId = newUlid();

  beforeEach(async () => {
    const db = await testDb.fresh();
    withTx = createWithTx(pgliteDriver(db));
    await asRole(db, 'app_owner', () =>
      db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, '主辦', 'practice'), ($2, '我的', 'owner')`, [host, mine]),
    );
    await withTx({ kind: 'org', orgId: host }, async (tx) => {
      const caseId = newUlid();
      await tx.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'lessor@example.com', 'x')`, [lessor]);
      await tx.query(`INSERT INTO org.cases (id, org_id, kind, state, business_type, title) VALUES ($1, $2, 'lease', 'active', 'master_lease', 't')`, [caseId, host]);
      await tx.query(`INSERT INTO org.case_members (id, org_id, case_id, party_id, relation) VALUES ($1, $2, $3, $4, 'lessor')`, [newUlid(), host, caseId, lessor]);
      await tx.query(`INSERT INTO org.contracts (id, org_id, case_id) VALUES ($1, $2, $3)`, [contractId, host, caseId]);
      await tx.query(
        `INSERT INTO org.sign_tasks (id, org_id, provider, provider_task_ref, subject_type, subject_id) VALUES ($1, $2, 'mock', 'shared-ref', 'contract', $3)`,
        [taskId, host, contractId],
      );
      await tx.query(
        `INSERT INTO org.signers (id, org_id, sign_task_id, position, role, name, email) VALUES ($1, $2, $3, 0, 'party_b', 'x', 'x@example.com')`,
        [newUlid(), host, taskId],
      );
      await tx.query(
        `INSERT INTO org.sign_task_files (id, org_id, sign_task_id, kind, status, file_name, object_key, sha256, byte_size, content_type)
         VALUES ($1, $2, $3, 'signed_pdf', 'saved', 'a.pdf', $4, $5, 10, 'application/pdf')`,
        [newUlid(), host, taskId, `org/${host}/sign-tasks/${taskId}/a.pdf`, 'a'.repeat(64)],
      );
    });
  });

  const asLessorInMine = <T>(fn: (tx: Tx<'org'>) => Promise<T>) => withTx({ kind: 'org', orgId: mine, partyId: lessor }, fn);

  it('前提：這個身分真的讀得到主辦組織的簽署任務（政策開放），查詢若不帶 org_id 就會讀到', async () => {
    const rows = await withTx({ kind: 'org', orgId: mine, partyId: lessor }, (tx) => tx.query('SELECT id FROM org.sign_tasks'));
    expect(rows.rows).toEqual([{ id: taskId }]);
  });

  it('findSignTask：用主辦組織的簽署標的查，在自己的組織讀不到', async () => {
    expect(await asLessorInMine((tx) => findSignTask(tx, { type: 'contract', id: contractId }))).toBeNull();
  });

  it('findSignTasks：批次查也讀不到', async () => {
    const found = await asLessorInMine((tx) => findSignTasks(tx, [{ type: 'contract', id: contractId }]));
    expect([...found.keys()]).toEqual([]);
  });

  it('findSignTaskByRef：服務商任務編號相同也讀不到', async () => {
    expect(await asLessorInMine((tx) => findSignTaskByRef(tx, 'mock', 'shared-ref'))).toBeNull();
  });

  it('簽署任務的檔案：getSignTaskFile 與 listSignTaskFiles 讀不到', async () => {
    expect(await asLessorInMine((tx) => getSignTaskFile(tx, taskId, 'signed_pdf'))).toBeNull();
    expect(await asLessorInMine((tx) => listSignTaskFiles(tx, taskId))).toEqual([]);
  });

  it('對照：在主辦組織自己的脈絡，三個查詢都讀得到', async () => {
    const own = <T>(fn: (tx: Tx<'org'>) => Promise<T>) => withTx({ kind: 'org', orgId: host }, fn);
    expect((await own((tx) => findSignTask(tx, { type: 'contract', id: contractId })))?.id).toBe(taskId);
    expect((await own((tx) => findSignTaskByRef(tx, 'mock', 'shared-ref')))?.id).toBe(taskId);
    expect((await own((tx) => listSignTaskFiles(tx, taskId))).length).toBe(1);
  });

  describe('案件成員經 withCaseMemberTx 讀簽署任務（正當的跨組織路徑）', () => {
    afterEach(() => useTxDriver(undefined));

    it('出租人成員（不屬於主辦組織）：交易的組織脈絡是案件所在的組織，讀得到簽署任務與檔案', async () => {
      const db = await testDb.fresh();
      useTxDriver(pgliteDriver(db));
      withTx = createWithTx(pgliteDriver(db));
      await asRole(db, 'app_owner', () => db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, '主辦', 'practice'), ($2, '我的', 'owner')`, [host, mine]));
      const caseId = newUlid();
      const contract = newUlid();
      const task = newUlid();
      await withTx({ kind: 'org', orgId: host }, async (tx) => {
        await tx.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'm@example.com', 'x')`, [lessor]);
        await tx.query(`INSERT INTO org.cases (id, org_id, kind, state, business_type, title) VALUES ($1, $2, 'lease', 'active', 'master_lease', 't')`, [caseId, host]);
        await tx.query(`INSERT INTO org.case_members (id, org_id, case_id, party_id, relation) VALUES ($1, $2, $3, $4, 'lessor')`, [newUlid(), host, caseId, lessor]);
        await tx.query(`INSERT INTO org.contracts (id, org_id, case_id) VALUES ($1, $2, $3)`, [contract, host, caseId]);
        await tx.query(`INSERT INTO org.sign_tasks (id, org_id, provider, provider_task_ref, subject_type, subject_id) VALUES ($1, $2, 'mock', 'm-ref', 'contract', $3)`, [task, host, contract]);
        await tx.query(
          `INSERT INTO org.sign_task_files (id, org_id, sign_task_id, kind, status, file_name, object_key, sha256, byte_size, content_type)
           VALUES ($1, $2, $3, 'signed_pdf', 'saved', 'a.pdf', $4, $5, 10, 'application/pdf')`,
          [newUlid(), host, task, `org/${host}/sign-tasks/${task}/a.pdf`, 'a'.repeat(64)],
        );
      });
      const rc = { kind: 'party' as const, userId: newUlid(), partyId: lessor, requestId: 't' };
      const seen = await withCaseMemberTx(rc, { caseId, action: 'inspection.confirm' }, async (tx) => ({
        task: (await findSignTask(tx, { type: 'contract', id: contract }))?.id,
        files: (await listSignTaskFiles(tx, task)).length,
      }));
      expect(seen).toEqual({ task, files: 1 });
    });
  });
});
