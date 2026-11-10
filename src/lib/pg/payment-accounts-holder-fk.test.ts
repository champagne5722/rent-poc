import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PGliteInterface } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pgliteDriver } from './drivers';
import { asRole, createTestDb, MIGRATIONS_DIR, type TestDb } from './test-harness';
import { newUlid } from './ulid';
import { createWithTx, type OrgTx, type WithTx } from './with-tx';

// MIL-187：org.payment_accounts.holder_party_id 的外鍵（migration 0074）。
// 外鍵是最後一道防線：應用層的持有人檢查（repository.test.ts）漏掉時，資料庫仍擋下不存在的 party。
// 外鍵用 ADD CONSTRAINT 補上，既有列不被修改。既有列有指到不存在 party 的，migration 必須失敗並說明。
// 注意：ADD CONSTRAINT 自己的驗證在 FORCE RLS 下看不到沒有組織脈絡的列，會靜默放行孤兒列，
// 所以 migration 逐組織先檢查。第二個組織的孤兒列也要被找到，由下方的測試守住。

const MIGRATION_FILE = '0074_payment_accounts_holder_fk.sql';
const CONSTRAINT = 'payment_accounts_holder_party_fk';

describe('收款帳戶持有人的外鍵（0074）', () => {
  let testDb: TestDb;
  let db: PGliteInterface;
  let withTx: WithTx;
  const orgA = newUlid();

  beforeAll(async () => {
    testDb = await createTestDb();
  });
  afterAll(() => testDb.close());
  beforeEach(async () => {
    db = await testDb.fresh();
    withTx = createWithTx(pgliteDriver(db));
    await asRole(db, 'app_owner', () => db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'A', 'owner')`, [orgA]));
  });

  const inA = <T>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: orgA }, fn);

  async function newParty(): Promise<string> {
    const id = newUlid();
    await asRole(db, 'app_owner', () =>
      db.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, $2, '王大明')`, [id, `${id.toLowerCase()}@example.com`]),
    );
    return id;
  }

  const insertAccount = (partyId: string | null, kind = 'lessor') =>
    inA((tx) =>
      tx.query(
        `INSERT INTO org.payment_accounts (id, org_id, name, holder_kind, holder_party_id, holder_name, account_kind)
         VALUES ($1, current_setting('app.org_id', true), '帳戶', $2, $3, '某人', 'cash')`,
        [newUlid(), kind, partyId],
      ),
    );

  /** 拿掉外鍵，模擬 0074 套用之前的資料庫。 */
  const dropConstraint = () =>
    asRole(db, 'app_owner', () => db.exec(`ALTER TABLE org.payment_accounts DROP CONSTRAINT ${CONSTRAINT}`));

  const applyMigration = async () => {
    const sql = await readFile(path.join(MIGRATIONS_DIR, MIGRATION_FILE), 'utf8');
    await asRole(db, 'app_owner', () => db.exec(sql));
  };

  it('持有人指到存在的 party 時可以寫入', async () => {
    await expect(insertAccount(await newParty())).resolves.toBeDefined();
  });

  it('持有人指到不存在的 party 時被外鍵擋下', async () => {
    await expect(insertAccount(newUlid())).rejects.toThrow(/payment_accounts_holder_party_fk|foreign key/i);
  });

  it('持有人是其他人（沒有 party）時不受外鍵影響', async () => {
    await expect(insertAccount(null, 'other')).resolves.toBeDefined();
  });

  it('外鍵指向 control.parties 的主鍵，約束名稱固定', async () => {
    const { rows } = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conname = $1 AND c.conrelid = 'org.payment_accounts'::regclass`,
      [CONSTRAINT],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].def).toMatch(/FOREIGN KEY \(holder_party_id\) REFERENCES control\.parties\(id\)/);
  });

  it('既有列都指到存在的 party 時，套用 migration 不修改任何列', async () => {
    const party = await newParty();
    await insertAccount(party);
    await insertAccount(null, 'other');
    await dropConstraint();
    const snapshot = () =>
      inA((tx) => tx.query<{ id: string; xmin: string }>('SELECT id, xmin::text AS xmin FROM org.payment_accounts ORDER BY id'));
    const before = (await snapshot()).rows;
    expect(before).toHaveLength(2);

    await applyMigration();

    expect((await snapshot()).rows).toEqual(before);
    await expect(insertAccount(newUlid())).rejects.toThrow(/foreign key/i);
  });

  it('既有列指到不存在的 party 時，migration 失敗並說明，不刪除也不改寫該列', async () => {
    await insertAccount(await newParty());
    await dropConstraint();
    const ghost = newUlid();
    await insertAccount(ghost);

    await expect(applyMigration()).rejects.toThrow(/不存在的 party/);
    await expect(applyMigration()).rejects.toThrow(/請先修正/);

    const { rows } = await inA((tx) => tx.query<{ holder_party_id: string }>('SELECT holder_party_id FROM org.payment_accounts ORDER BY id'));
    expect(rows.map((r) => r.holder_party_id)).toContain(ghost);
    expect(rows).toHaveLength(2);
    // 失敗後外鍵仍不存在，沒有半套狀態
    const { rows: constraint } = await db.query(`SELECT 1 FROM pg_constraint WHERE conname = $1`, [CONSTRAINT]);
    expect(constraint).toHaveLength(0);
  });

  it('孤兒列在別的組織時也找得到：逐組織檢查，不只看第一個組織', async () => {
    const orgB = newUlid();
    await asRole(db, 'app_owner', () => db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'B', 'owner')`, [orgB]));
    await insertAccount(await newParty());
    await dropConstraint();
    await withTx({ kind: 'org', orgId: orgB }, (tx) =>
      tx.query(
        `INSERT INTO org.payment_accounts (id, org_id, name, holder_kind, holder_party_id, holder_name, account_kind)
         VALUES ($1, current_setting('app.org_id', true), 'B 帳戶', 'lessor', $2, '某人', 'cash')`,
        [newUlid(), newUlid()],
      ),
    );

    await expect(applyMigration()).rejects.toThrow(/共 1 列/);
  });
});
