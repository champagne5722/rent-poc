import type { PGliteInterface } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pgliteDriver } from './drivers';
import { asRole, createTestDb, type TestDb } from './test-harness';
import { newUlid } from './ulid';
import { createWithTx, type OrgTx, type WithTx } from './with-tx';

// MIL-85：簽署任務、簽署人、文件紀錄、outbox 與路由列的表。約束都從外部（app_rw）觀察。

describe('簽署任務相關的表', () => {
  let testDb: TestDb;
  let db: PGliteInterface;
  let withTx: WithTx;
  const orgA = newUlid();
  const orgB = newUlid();

  beforeAll(async () => {
    testDb = await createTestDb();
  });
  afterAll(() => testDb.close());

  beforeEach(async () => {
    db = await testDb.fresh();
    withTx = createWithTx(pgliteDriver(db));
    await asRole(db, 'app_owner', async () => {
      await db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'A', 'owner'), ($2, 'B', 'owner')`, [orgA, orgB]);
    });
  });

  const inOrg = <T>(orgId: string, fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId }, fn);

  const insertTask = async (tx: OrgTx, orgId: string, over: { ref?: string; subject?: string; provider?: string } = {}) => {
    const id = newUlid();
    await tx.query(
      `INSERT INTO org.sign_tasks (id, org_id, provider, provider_task_ref, subject_type, subject_id)
       VALUES ($1, $2, $3, $4, 'contract', $5)`,
      [id, orgId, over.provider ?? 'dottedsign', over.ref ?? newUlid(), over.subject ?? newUlid()],
    );
    return id;
  };
  const insertSigner = (tx: OrgTx, orgId: string, taskId: string, position = 0, over: { role?: string } = {}) =>
    tx.query(
      `INSERT INTO org.signers (id, org_id, sign_task_id, position, role, name, email) VALUES ($1, $2, $3, $4, $5, 'x', 'x@example.com')`,
      [newUlid(), orgId, taskId, position, over.role ?? 'party_b'],
    );
  const insertRoute = (tx: OrgTx, orgId: string, taskId: string, ref: string, provider = 'dottedsign') =>
    tx.query(`INSERT INTO control.sign_task_routes (provider, provider_task_ref, org_id, sign_task_id) VALUES ($1, $2, $3, $4)`, [
      provider,
      ref,
      orgId,
      taskId,
    ]);

  describe('簽署任務', () => {
    it('subject_id 必須是 ULID', async () => {
      await expect(inOrg(orgA, (tx) => insertTask(tx, orgA, { subject: '12' }))).rejects.toThrow(/check constraint/);
    });

    it('一個簽署標的最多一個簽署任務', async () => {
      const subject = newUlid();
      await inOrg(orgA, (tx) => insertTask(tx, orgA, { subject }));
      await expect(inOrg(orgA, (tx) => insertTask(tx, orgA, { subject }))).rejects.toThrow(/duplicate key/);
    });

    it('兩個組織可以有相同的服務商任務編號與簽署標的 ID（唯一鍵含 org_id）', async () => {
      await inOrg(orgA, (tx) => insertTask(tx, orgA, { ref: 'same', subject: '0'.repeat(25) + '1' }));
      await expect(inOrg(orgB, (tx) => insertTask(tx, orgB, { ref: 'same', subject: '0'.repeat(25) + '1' }))).resolves.toBeTruthy();
    });

    it('狀態與服務商只收已知的值', async () => {
      await expect(
        inOrg(orgA, (tx) =>
          tx.query(
            `INSERT INTO org.sign_tasks (id, org_id, provider, provider_task_ref, subject_type, subject_id, status)
             VALUES ($1, $2, 'mock', 'r', 'contract', $3, 'weird')`,
            [newUlid(), orgA, newUlid()],
          ),
        ),
      ).rejects.toThrow(/check constraint/);
      await expect(inOrg(orgA, (tx) => insertTask(tx, orgA, { provider: 'other' }))).rejects.toThrow(/check constraint/);
    });
  });

  describe('簽署人的複合外鍵', () => {
    it('簽署人只能掛在同組織的簽署任務上', async () => {
      const taskA = await inOrg(orgA, (tx) => insertTask(tx, orgA));
      await expect(inOrg(orgA, (tx) => insertSigner(tx, orgA, taskA))).resolves.toBeTruthy();
      // B 組織引用 A 組織的簽署任務：外鍵看得到 A 的列（不受 RLS 限制），但 (org_id, id) 對不上
      await expect(inOrg(orgB, (tx) => insertSigner(tx, orgB, taskA))).rejects.toThrow(/foreign key/);
    });

    it('同一個簽署任務的順序不得重複，角色只收已知的值', async () => {
      const task = await inOrg(orgA, (tx) => insertTask(tx, orgA));
      await inOrg(orgA, (tx) => insertSigner(tx, orgA, task, 0));
      await expect(inOrg(orgA, (tx) => insertSigner(tx, orgA, task, 0))).rejects.toThrow(/duplicate key/);
      await expect(inOrg(orgA, (tx) => insertSigner(tx, orgA, task, 1, { role: 'landlord' }))).rejects.toThrow(/check constraint/);
    });

    it('concurrent_roles 必須是陣列', async () => {
      const task = await inOrg(orgA, (tx) => insertTask(tx, orgA));
      await expect(
        inOrg(orgA, (tx) =>
          tx.query(
            `INSERT INTO org.signers (id, org_id, sign_task_id, position, role, name, email, concurrent_roles)
             VALUES ($1, $2, $3, 0, 'practitioner', 'x', 'x@example.com', '"party_a"'::jsonb)`,
            [newUlid(), orgA, task],
          ),
        ),
      ).rejects.toThrow(/check constraint/);
    });
  });

  describe('文件紀錄的複合外鍵', () => {
    it('文件紀錄只能掛在同組織的簽署任務上，每種文件一列', async () => {
      const taskA = await inOrg(orgA, (tx) => insertTask(tx, orgA));
      const insertFile = (tx: OrgTx, orgId: string) =>
        tx.query(
          `INSERT INTO org.sign_task_files (id, org_id, sign_task_id, kind, status, file_name, object_key, sha256, byte_size)
           VALUES ($1, $2, $3, 'signed_pdf', 'saved', 'a.pdf', $4, $5, 1)`,
          [newUlid(), orgId, taskA, `org/${orgId}/sign-tasks/${taskA}/a.pdf`, 'a'.repeat(64)],
        );
      await inOrg(orgA, (tx) => insertFile(tx, orgA));
      await expect(inOrg(orgA, (tx) => insertFile(tx, orgA))).rejects.toThrow(/duplicate key/);
      await expect(inOrg(orgB, (tx) => insertFile(tx, orgB))).rejects.toThrow(/foreign key/);
    });
  });

  describe('outbox', () => {
    const insertOutbox = (tx: OrgTx, subject: string, action: string, status: string) =>
      tx.query(
        `INSERT INTO org.outbox (id, org_id, action, subject_type, subject_id, status)
         VALUES ($1, current_setting('app.org_id', true), $2, 'contract', $3, $4)`,
        [newUlid(), action, subject, status],
      );

    it('同一個簽署標的、同一種動作同時只有一列在進行', async () => {
      const subject = newUlid();
      await inOrg(orgA, (tx) => insertOutbox(tx, subject, 'create_sign_task', 'sending'));
      await expect(inOrg(orgA, (tx) => insertOutbox(tx, subject, 'create_sign_task', 'pending'))).rejects.toThrow(/duplicate key/);
      // 不同動作、不同組織、已結束的列都不衝突
      await expect(inOrg(orgA, (tx) => insertOutbox(tx, subject, 'void_sign_task', 'pending'))).resolves.toBeTruthy();
      await expect(inOrg(orgB, (tx) => insertOutbox(tx, subject, 'create_sign_task', 'sending'))).resolves.toBeTruthy();
    });

    it('結束的列（done、failed、dead、skipped）不佔位，可以再排', async () => {
      const subject = newUlid();
      for (const status of ['done', 'failed', 'dead', 'skipped']) {
        await inOrg(orgA, (tx) => insertOutbox(tx, subject, 'void_sign_task', status));
      }
      await expect(inOrg(orgA, (tx) => insertOutbox(tx, subject, 'void_sign_task', 'pending'))).resolves.toBeTruthy();
    });

    it('動作與狀態只收已知的值', async () => {
      await expect(inOrg(orgA, (tx) => insertOutbox(tx, newUlid(), 'delete_everything', 'pending'))).rejects.toThrow(/check constraint/);
      await expect(inOrg(orgA, (tx) => insertOutbox(tx, newUlid(), 'void_sign_task', 'weird'))).rejects.toThrow(/check constraint/);
    });
  });

  describe('control.sign_task_routes', () => {
    it('control 脈絡能由服務商任務編號查出組織', async () => {
      const task = await inOrg(orgA, async (tx) => {
        const id = await insertTask(tx, orgA, { ref: 'route-1' });
        await insertRoute(tx, orgA, id, 'route-1');
        return id;
      });
      const { rows } = await withTx({ kind: 'control' }, (tx) =>
        tx.query(`SELECT org_id, sign_task_id FROM control.sign_task_routes WHERE provider = 'dottedsign' AND provider_task_ref = 'route-1'`),
      );
      expect(rows).toEqual([{ org_id: orgA, sign_task_id: task }]);
    });

    it('服務商任務編號跨組織唯一：B 組織不能用 A 組織已登記的編號', async () => {
      await inOrg(orgA, async (tx) => insertRoute(tx, orgA, await insertTask(tx, orgA, { ref: 'taken' }), 'taken'));
      await expect(
        inOrg(orgB, async (tx) => insertRoute(tx, orgB, await insertTask(tx, orgB, { ref: 'taken' }), 'taken')),
      ).rejects.toThrow(/duplicate key/);
    });

    it('路由列必須指向同組織的簽署任務（複合外鍵）', async () => {
      const taskA = await inOrg(orgA, (tx) => insertTask(tx, orgA));
      await expect(inOrg(orgB, (tx) => insertRoute(tx, orgB, taskA, 'cross'))).rejects.toThrow(/foreign key/);
    });

    it('app_rw 不能改或刪路由列', async () => {
      await inOrg(orgA, async (tx) => insertRoute(tx, orgA, await insertTask(tx, orgA, { ref: 'fixed' }), 'fixed'));
      await expect(inOrg(orgA, (tx) => tx.query(`UPDATE control.sign_task_routes SET org_id = org_id`))).rejects.toThrow(/permission denied/);
      await expect(inOrg(orgA, (tx) => tx.query(`DELETE FROM control.sign_task_routes`))).rejects.toThrow(/permission denied/);
    });

    it('路由列與簽署任務同交易：交易回滾時兩者都不留', async () => {
      await expect(
        inOrg(orgA, async (tx) => {
          await insertRoute(tx, orgA, await insertTask(tx, orgA, { ref: 'rolled-back' }), 'rolled-back');
          throw new Error('中途失敗');
        }),
      ).rejects.toThrow('中途失敗');
      const { rows } = await withTx({ kind: 'control' }, (tx) => tx.query('SELECT 1 FROM control.sign_task_routes'));
      expect(rows).toEqual([]);
    });
  });
});
