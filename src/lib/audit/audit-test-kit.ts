import type { PGliteInterface } from '@electric-sql/pglite';
import { pgliteDriver } from '../pg/drivers';
import { createTestDb, type TestDb } from '../pg/test-harness';
import { createWithTx, type OrgContext, type WithTx } from '../pg/with-tx';

// 稽核測試共用的工具。只給 *.test.ts 使用。

export const ORG_A = '01JBKQ0000000000000000000A';
export const ORG_B = '01JBKQ0000000000000000000B';
export const PARTY_P = '01JBKQ0000000000000000000P';
export const OPERATOR_X = '01JBKQ0000000000000000000X';
/** 種子的平台組織，見 db/migrations/0002_control_orgs.sql。 */
export const PLATFORM_ORG = '00000000000000000000000001';

export const orgCtx = (orgId: string): OrgContext => ({ kind: 'org', orgId });

export interface AuditFixture {
  db: PGliteInterface;
  withTx: WithTx;
  close(): Promise<void>;
}

/** 每個測試一份獨立的資料庫副本，連線身分是 app_rw（harness 的 fresh() 保證）。 */
export async function openFixture(testDb: TestDb): Promise<AuditFixture> {
  const db = await testDb.fresh();
  return { db, withTx: createWithTx(pgliteDriver(db)), close: () => db.close() };
}

export { createTestDb };

/**
 * 以 superuser 身分做事，模擬資料庫被入侵或維運人員越權（ADR-0019 實測情境）。
 * 做完或丟錯都回到 app_rw。只有 harness 的 clone 是 postgres 起頭，所以 RESET ROLE 能回到 superuser。
 */
export async function asSuperuser<T>(db: PGliteInterface, fn: () => Promise<T>): Promise<T> {
  await db.exec('RESET ROLE');
  try {
    return await fn();
  } finally {
    await db.exec('SET ROLE app_rw');
  }
}

/** 暫時關掉事件表的觸發器，做完恢復。只有 superuser 做得到。 */
export async function withTriggersOff<T>(db: PGliteInterface, fn: () => Promise<T>): Promise<T> {
  return asSuperuser(db, async () => {
    await db.exec('ALTER TABLE audit.events DISABLE TRIGGER USER');
    try {
      return await fn();
    } finally {
      await db.exec('ALTER TABLE audit.events ENABLE TRIGGER USER');
    }
  });
}
