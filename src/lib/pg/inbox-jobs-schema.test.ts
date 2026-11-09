import type { PGliteInterface } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pgliteDriver } from './drivers';
import { createTestDb, type TestDb } from './test-harness';
import { newUlid } from './ulid';
import { createWithTx, type ControlTx, type WithTx } from './with-tx';

// MIL-86：control.inbox_messages 與 control.timer_fires。約束都從外部（app_rw）觀察。
// 權限與例外清單的一致性由 rls-penetration.test.ts 的「control 表的例外清單」檢查。

describe('inbox 與計時器冪等紀錄的表', () => {
  let testDb: TestDb;
  let db: PGliteInterface;
  let withTx: WithTx;

  beforeAll(async () => {
    testDb = await createTestDb();
  });
  afterAll(() => testDb.close());
  beforeEach(async () => {
    db = await testDb.fresh();
    withTx = createWithTx(pgliteDriver(db));
  });

  const inControl = <T,>(fn: (tx: ControlTx) => Promise<T>) => withTx({ kind: 'control' }, fn);
  const SHA = 'a'.repeat(64);

  const insertInbox = (tx: ControlTx, over: Record<string, unknown> = {}) => {
    const v = { id: newUlid(), provider: 'dottedsign', sha: SHA, ref: 'task-1', type: 'signed', status: 'pending', ...over };
    return tx.query(
      `INSERT INTO control.inbox_messages (id, provider, body_sha256, provider_task_ref, event_type, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [v.id, v.provider, v.sha, v.ref, v.type, v.status],
    );
  };

  describe('control.inbox_messages', () => {
    it('沒有存原始 body 的欄位：欄位只有標準化事件、雜湊與處理狀態', async () => {
      const { rows } = await testDb.base.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'control' AND table_name = 'inbox_messages' ORDER BY ordinal_position`,
      );
      expect(rows.map((r) => r.column_name)).toEqual([
        'id',
        'provider',
        'body_sha256',
        'provider_task_ref',
        'event_type',
        'event_email',
        'event_reason',
        'occurred_at',
        'status',
        'attempts',
        'last_error',
        'received_at',
        'updated_at',
        'processed_at',
      ]);
    });

    it('相同服務商與 body 雜湊只能有一列（去重鍵）；不同服務商或不同雜湊可以並存', async () => {
      await inControl((tx) => insertInbox(tx));
      await expect(inControl((tx) => insertInbox(tx))).rejects.toThrow(/duplicate key|unique/i);
      await inControl((tx) => insertInbox(tx, { provider: 'mock' }));
      await inControl((tx) => insertInbox(tx, { sha: 'b'.repeat(64) }));
    });

    it('欄位檢查：雜湊必須是 64 碼小寫十六進位，事件、狀態、服務商只能是已知的值', async () => {
      for (const over of [
        { sha: 'A'.repeat(64) },
        { sha: 'abc' },
        { type: 'viewed' },
        { status: 'weird' },
        { provider: 'docusign' },
        { id: 'not-a-ulid' },
      ]) {
        await expect(inControl((tx) => insertInbox(tx, over))).rejects.toThrow(/check constraint/);
      }
    });

    it('app_rw 能新增與更新狀態，但不能刪除', async () => {
      await inControl((tx) => insertInbox(tx));
      await inControl((tx) => tx.query(`UPDATE control.inbox_messages SET status = 'done'`));
      await expect(inControl((tx) => tx.query('DELETE FROM control.inbox_messages'))).rejects.toThrow(/permission denied/);
      await expect(inControl((tx) => tx.query('TRUNCATE control.inbox_messages'))).rejects.toThrow(/permission denied/);
    });
  });

  describe('control.timer_fires', () => {
    const insertFire = (tx: ControlTx, key: string, over: Record<string, unknown> = {}) =>
      tx.query(
        `INSERT INTO control.timer_fires (idempotency_key, timer, subject_id, event, fire_date, org_id)
         VALUES ($1, 'probe', 'S1', 'probe_due', $2, $3)`,
        [key, over.date ?? '2026-11-09', over.orgId ?? null],
      );

    it('冪等鍵是主鍵：同一把鍵寫第二次被擋下', async () => {
      await inControl((tx) => insertFire(tx, 'S1:probe_due:2026-11-09'));
      await expect(inControl((tx) => insertFire(tx, 'S1:probe_due:2026-11-09'))).rejects.toThrow(/duplicate key/);
    });

    it('日期是 YYYY-MM-DD 或 YYYY-MM', async () => {
      await inControl((tx) => insertFire(tx, 'k1', { date: '2026-11' }));
      await expect(inControl((tx) => insertFire(tx, 'k2', { date: '11/09' }))).rejects.toThrow(/check constraint/);
    });

    it('org_id 必須是存在的組織，或空值（全域計時器）', async () => {
      await expect(inControl((tx) => insertFire(tx, 'k3', { orgId: newUlid() }))).rejects.toThrow(/foreign key/);
    });

    it('寫入後不變：app_rw 不能更新也不能刪除', async () => {
      await inControl((tx) => insertFire(tx, 'k4'));
      await expect(inControl((tx) => tx.query(`UPDATE control.timer_fires SET fire_date = '2026-12-01'`))).rejects.toThrow(/permission denied/);
      await expect(inControl((tx) => tx.query('DELETE FROM control.timer_fires'))).rejects.toThrow(/permission denied/);
    });
  });
});
