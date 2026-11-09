import type { PGliteInterface } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OUTBOX_ACTIONS } from '../signing-module/outbox';
import { pgliteDriver } from './drivers';
import { asRole, createTestDb, type TestDb } from './test-harness';
import { newUlid } from './ulid';
import { createWithTx, type WithTx } from './with-tx';

// 全部 migration 套用後，org.outbox.action 的 CHECK 必須是所有票新增動作的聯集。
// 0008（MIL-87）加了 save_sign_task_files，0053（MIL-120）加了 send_email 並重設清單，
// 兩條線合併後後者會蓋掉前者，0054 補齊。這個測試固定「每個動作都能寫入」。

describe('org.outbox.action 的 CHECK', () => {
  let testDb: TestDb;
  let db: PGliteInterface;
  let withTx: WithTx;
  const orgId = newUlid();

  beforeAll(async () => {
    testDb = await createTestDb();
  });
  afterAll(() => testDb.close());

  beforeEach(async () => {
    db = await testDb.fresh();
    withTx = createWithTx(pgliteDriver(db));
    await asRole(db, 'app_owner', async () => {
      await db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'A', 'owner')`, [orgId]);
    });
  });

  const insertAction = (action: string) =>
    withTx({ kind: 'org', orgId }, (tx) =>
      tx.query(
        `INSERT INTO org.outbox (id, org_id, action, subject_type, subject_id, status) VALUES ($1, $2, $3, 'contract', $4, 'pending')`,
        [newUlid(), orgId, action, newUlid()],
      ),
    );

  it.each(OUTBOX_ACTIONS)('動作 %s 能寫入', async (action) => {
    await expect(insertAction(action)).resolves.toBeDefined();
  });

  it('清單內要有 A 線與 E 線各自新增的動作', () => {
    expect(OUTBOX_ACTIONS).toEqual(expect.arrayContaining(['save_sign_task_files', 'send_email']));
  });

  it('不在清單內的動作被擋下', async () => {
    await expect(insertAction('drop_everything')).rejects.toThrow(/outbox_action_check/);
  });
});
