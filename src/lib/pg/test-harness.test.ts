import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asRole, createTestDb, type TestDb } from './test-harness';

// ADR-0012 Action Item 5：clone() 之後 current_user 會回到 postgres，
// 而 postgres 繞過 RLS，RLS 測試會全部假通過。這份測試證明 harness 擋住了這件事。

describe('測試 harness', () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
  });
  afterAll(() => testDb.close());

  it('控制組：沒經過 harness 的 clone() 會變回 postgres', async () => {
    const raw = await testDb.base.clone();
    try {
      const { rows } = await raw.query<{ u: string }>('SELECT current_user AS u');
      expect(rows[0].u).toBe('postgres');
    } finally {
      await raw.close();
    }
  });

  it('fresh() 回傳的連線，current_user 是 app_rw，且不是 superuser 也沒有 BYPASSRLS', async () => {
    const db = await testDb.fresh();
    try {
      const { rows } = await db.query<{ u: string; super: boolean; bypass: boolean }>(
        `SELECT current_user AS u, r.rolsuper AS super, r.rolbypassrls AS bypass
           FROM pg_roles r WHERE r.rolname = current_user`,
      );
      expect(rows[0]).toEqual({ u: 'app_rw', super: false, bypass: false });
    } finally {
      await db.close();
    }
  });

  it('每次 fresh() 都是 app_rw，不只第一次', async () => {
    const a = await testDb.fresh();
    const b = await testDb.fresh();
    try {
      for (const db of [a, b]) {
        const { rows } = await db.query<{ u: string }>('SELECT current_user AS u');
        expect(rows[0].u).toBe('app_rw');
      }
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('不同 fresh() 之間互相隔離', async () => {
    const a = await testDb.fresh();
    const b = await testDb.fresh();
    try {
      await asRole(a, 'app_owner', () => a.exec('CREATE TABLE org.iso_probe (id int)'));
      await a.exec('INSERT INTO org.iso_probe VALUES (1)');
      const { rows } = await a.query('SELECT * FROM org.iso_probe');
      expect(rows).toHaveLength(1);
      await expect(b.query('SELECT * FROM org.iso_probe')).rejects.toThrow(/does not exist/);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('asRole 做完事會回到 app_rw，即使中途丟錯', async () => {
    const db = await testDb.fresh();
    try {
      await expect(
        asRole(db, 'audit_owner', async () => {
          const { rows } = await db.query<{ u: string }>('SELECT current_user AS u');
          expect(rows[0].u).toBe('audit_owner');
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      const { rows } = await db.query<{ u: string }>('SELECT current_user AS u');
      expect(rows[0].u).toBe('app_rw');
    } finally {
      await db.close();
    }
  });
});
