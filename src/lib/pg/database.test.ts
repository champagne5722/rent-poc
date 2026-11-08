import { afterEach, describe, expect, it } from 'vitest';
import { useTxDriver, withTx } from './database';
import { DEFAULT_POOL_MAX, pgPoolConfig, pgliteDriver } from './drivers';
import { createTestDb } from './test-harness';

describe('預設的 withTx', () => {
  afterEach(() => useTxDriver(undefined));

  it('useTxDriver 換成 PGlite 後，withTx 走注入的驅動', async () => {
    const testDb = await createTestDb();
    const db = await testDb.fresh();
    try {
      useTxDriver(pgliteDriver(db));
      const user = await withTx({ kind: 'control' }, async (tx) => (await tx.query<{ u: string }>('SELECT current_user AS u')).rows[0].u);
      expect(user).toBe('app_rw');
    } finally {
      useTxDriver(undefined);
      await db.close();
      await testDb.close();
    }
  });
});

describe('pgPoolConfig', () => {
  it('沒有 DATABASE_URL 時丟錯，不會安靜地連到預設值', () => {
    expect(() => pgPoolConfig({})).toThrow(/DATABASE_URL/);
    expect(() => pgPoolConfig({ DATABASE_URL: '  ' })).toThrow(/DATABASE_URL/);
  });

  it('連線池上限預設 5，可用 PG_POOL_MAX 調整，非法值丟錯', () => {
    const base = { DATABASE_URL: 'postgres://app_rw@localhost/db' };
    expect(pgPoolConfig(base).max).toBe(DEFAULT_POOL_MAX);
    expect(pgPoolConfig({ ...base, PG_POOL_MAX: '8' }).max).toBe(8);
    expect(() => pgPoolConfig({ ...base, PG_POOL_MAX: '0' })).toThrow(/PG_POOL_MAX/);
    expect(() => pgPoolConfig({ ...base, PG_POOL_MAX: 'many' })).toThrow(/PG_POOL_MAX/);
  });
});
