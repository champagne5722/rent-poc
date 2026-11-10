import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgDriver } from '../../pg/drivers';
import { createPgTestDatabase, type PgTestDatabase } from '../../pg/pg-database-kit';
import { newUlid } from '../../pg/ulid';
import { createWithTx, type DbContext } from '../../pg/with-tx';
import { appendAudit } from '../append';

// 錨定函式只准沒有組織脈絡的 job 呼叫（MIL-89，0078）。
// 之前任何 app_rw 連線都能呼叫：org 脈絡的請求讀得到所有組織的鏈編號與雜湊，也能寫入錨定紀錄。
// 只在有 TEST_DATABASE_URL 時執行。
const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('錨定函式的呼叫脈絡（真實 PostgreSQL）', () => {
  let dbh: PgTestDatabase;
  const orgA = newUlid();
  const orgB = newUlid();
  const partyId = newUlid();
  const withTx = () => createWithTx(pgDriver(dbh.pool));

  const SQL = {
    heads: 'SELECT chain_id FROM audit.unanchored_heads()',
    failure: `SELECT audit.record_anchor_failure(now(), 'x')`,
    anchor: `SELECT audit.record_anchor(now(), 'mock', repeat('a', 64), 'r', now(), '[]'::jsonb)`,
  } as const;

  const call = (ctx: DbContext, sql: string) => withTx()(ctx, (tx) => tx.query<Record<string, unknown>>(sql));

  beforeAll(async () => {
    dbh = await createPgTestDatabase(adminUrl!, 1);
    await dbh.owner.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'A', 'owner'), ($2, 'B', 'owner')`, [orgA, orgB]);
    await dbh.owner.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'p@example.com', 'x')`, [partyId]);
    await withTx()({ kind: 'org', orgId: orgA }, (tx) => appendAudit(tx, { action: 'member.grant' }));
    await withTx()({ kind: 'org', orgId: orgB }, (tx) => appendAudit(tx, { action: 'member.grant' }));
  }, 120_000);
  afterAll(() => dbh?.close());

  const denied = { code: '42501', message: expect.stringContaining('control 交易') };

  it.each(Object.entries(SQL))('org 脈絡呼叫 %s 被拒絕', async (_name, sql) => {
    await expect(call({ kind: 'org', orgId: orgA }, sql)).rejects.toMatchObject(denied);
  });

  it.each(Object.entries(SQL))('org 脈絡帶 party 呼叫 %s 被拒絕', async (_name, sql) => {
    await expect(call({ kind: 'org', orgId: orgA, partyId }, sql)).rejects.toMatchObject(denied);
  });

  it.each(Object.entries(SQL))('party 脈絡呼叫 %s 被拒絕', async (_name, sql) => {
    await expect(call({ kind: 'party', partyId }, sql)).rejects.toMatchObject(denied);
  });

  it('org A 的脈絡讀不到 org B 的鏈（重現 MIL-89 找到的洩漏）', async () => {
    const result = await call({ kind: 'org', orgId: orgA }, SQL.heads).then(
      (r) => r.rows.map((x) => x.chain_id),
      () => [],
    );
    expect(result).not.toContain(orgB);
  });

  it('control 脈絡照常運作：列出所有未錨定的鏈、記錄失敗', async () => {
    const heads = await call({ kind: 'control' }, SQL.heads);
    expect(heads.rows.map((r) => r.chain_id)).toEqual(expect.arrayContaining([orgA, orgB]));
    const failure = await call({ kind: 'control' }, SQL.failure);
    expect(Number(failure.rows[0].record_anchor_failure)).toBeGreaterThanOrEqual(1);
  });

  it('control 脈絡的 record_anchor 仍然檢查葉：空陣列被拒絕，但不是脈絡錯誤', async () => {
    await expect(call({ kind: 'control' }, SQL.anchor)).rejects.toThrow('錨定至少要有一片葉');
  });

  it('org 脈絡自己這條鏈的錨定（chain_anchors）不受影響', async () => {
    const rows = await call({ kind: 'org', orgId: orgA }, 'SELECT * FROM audit.chain_anchors()');
    expect(rows.rows).toEqual([]);
  });
});
