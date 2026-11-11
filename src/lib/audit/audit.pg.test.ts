import { Client, type Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgDriver } from '../pg/drivers';
import { fromPgClient } from '../pg/executor';
import { migrate } from '../pg/migrate';
import { closeTestPool, createTestPool, dropTestDatabase } from '../pg/pg-database-kit';
import { withClusterLock } from '../pg/pg-test-support';
import { MIGRATIONS_DIR } from '../pg/test-harness';
import { createWithTx, type WithTx } from '../pg/with-tx';
import { ORG_A, ORG_B, OPERATOR_X, PLATFORM_ORG, orgCtx } from './audit-test-kit';
import { appendAudit, verifyChain } from './index';

// MIL-82 在真實 PostgreSQL 的驗證：pg 驅動（bigint 回傳字串）、真正的角色與登入、併發寫入同一條鏈
// （ADR-0019 Action Item 3）。只在有 TEST_DATABASE_URL 時執行，說明見 pg-integration.test.ts。

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('稽核鏈：真實 PostgreSQL', () => {
  const dbName = `audit_${Math.random().toString(36).slice(2, 10)}`;
  const urlFor = (user: string, password: string, db: string) => {
    const u = new URL(adminUrl!);
    u.username = user;
    u.password = password;
    u.pathname = `/${db}`;
    return u.toString();
  };
  let admin: Client; // 管理者身分連到測試用資料庫，模擬超級使用者
  let pool: Pool;
  let withTx: WithTx;

  beforeAll(async () => {
    const root = new Client({ connectionString: adminUrl });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const { username, password } = new URL(adminUrl!);
    admin = new Client({ connectionString: urlFor(decodeURIComponent(username), decodeURIComponent(password), dbName) });
    await admin.connect();
    // 角色是叢集共用的，與其他測試檔並行時要排隊（見 pg-test-support.ts）
    await withClusterLock(adminUrl!, async () => {
      await migrate(fromPgClient(admin), { dir: MIGRATIONS_DIR, runAs: 'app_owner' });
      await admin.query(`ALTER ROLE app_rw PASSWORD 'rw-test'`);
    });
    pool = createTestPool({ connectionString: urlFor('app_rw', 'rw-test', dbName), max: 5 });
    withTx = createWithTx(pgDriver(pool));
  });
  afterAll(async () => {
    await closeTestPool(pool);
    await admin.end();
    await dropTestDatabase(adminUrl!, dbName);
  });

  const seqsOf = (orgId: string) =>
    withTx(orgCtx(orgId), async (tx) => (await tx.query<{ seq: string }>('SELECT e.seq::text AS seq FROM audit.events e ORDER BY e.seq')).rows.map((r) => Number(r.seq)));

  it('audit 的物件由 audit_owner 擁有，連線池的身分 app_rw 不能直接寫', async () => {
    const owners = await admin.query(
      `SELECT c.relname, r.rolname AS owner, r.rolbypassrls FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
        WHERE c.relnamespace = 'audit'::regnamespace AND c.relkind = 'r' ORDER BY 1`,
    );
    expect(owners.rows).toEqual([
      { relname: 'anchor_batches', owner: 'audit_owner', rolbypassrls: false },
      { relname: 'anchor_leaves', owner: 'audit_owner', rolbypassrls: false },
      { relname: 'anchor_runs', owner: 'audit_owner', rolbypassrls: false },
      { relname: 'chain_heads', owner: 'audit_owner', rolbypassrls: false },
      { relname: 'events', owner: 'audit_owner', rolbypassrls: false },
    ]);
    for (const sql of [`INSERT INTO audit.events (chain_id, seq) VALUES ('x', 1)`, 'UPDATE audit.events SET seq = 1', 'DELETE FROM audit.events', 'TRUNCATE audit.events', 'SELECT * FROM audit.chain_heads']) {
      await expect(withTx({ kind: 'control' }, (tx) => tx.query(sql))).rejects.toThrow(/permission denied/);
    }
  });

  it('audit_owner 的 UPDATE、DELETE、TRUNCATE 被觸發器擋下', async () => {
    await withTx(orgCtx(ORG_A), (tx) => appendAudit(tx, { action: 'member.grant' }));
    for (const sql of ['UPDATE audit.events SET seq = seq', 'DELETE FROM audit.events', 'TRUNCATE audit.events']) {
      await admin.query('SET ROLE audit_owner');
      try {
        await expect(admin.query(sql)).rejects.toThrow(/稽核紀錄只增不改/);
      } finally {
        await admin.query('RESET ROLE');
      }
    }
  });

  it('併發寫入同一條鏈：20 個交易同時寫，序號 1 到 20 不重複不跳號，鏈驗證通過', async () => {
    const orgId = '01JBKQ00000000000000000C01';
    const refs = await Promise.all(
      Array.from({ length: 20 }, (_, i) => withTx(orgCtx(orgId), (tx) => appendAudit(tx, { action: 'ledger.entry', payload: { i } }))),
    );
    expect(refs.map((r) => r.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(await seqsOf(orgId)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(await withTx(orgCtx(orgId), (tx) => verifyChain(tx))).toMatchObject({ ok: true, count: 20 });
  });

  it('併發寫入且有一半回滾：留下來的序號仍然連續', async () => {
    const orgId = '01JBKQ00000000000000000C02';
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        withTx(orgCtx(orgId), async (tx) => {
          await appendAudit(tx, { action: 'ledger.entry', payload: { i } });
          if (i % 2 === 0) throw new Error('rollback');
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(6);
    expect(await seqsOf(orgId)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await withTx(orgCtx(orgId), (tx) => verifyChain(tx))).toMatchObject({ ok: true, count: 6 });
  });

  it('兩個組織同時第一次寫入，各自從 1 開始互不影響', async () => {
    const [a, b] = ['01JBKQ00000000000000000D01', '01JBKQ00000000000000000D02'];
    await Promise.all([a, b, a, b].map((o) => withTx(orgCtx(o), (tx) => appendAudit(tx, { action: 'member.grant' }))));
    expect(await seqsOf(a)).toEqual([1, 2]);
    expect(await seqsOf(b)).toEqual([1, 2]);
  });

  it('沒有組織脈絡的併發寫入都進平台鏈，A 組織脈絡讀不到', async () => {
    await Promise.all(Array.from({ length: 5 }, () => withTx({ kind: 'control' }, (tx) => appendAudit(tx, { action: 'tenant.login' }))));
    expect((await seqsOf(PLATFORM_ORG)).length).toBeGreaterThanOrEqual(5);
    const rows = await withTx({ kind: 'control' }, async (tx) => (await tx.query('SELECT 1 FROM audit.events')).rows);
    expect(rows).toEqual([]);
  });

  it('session 時區是 Asia/Taipei 時，canonical 仍是 UTC，驗證通過', async () => {
    const orgId = '01JBKQ00000000000000000E01';
    await withTx(orgCtx(orgId), async (tx) => {
      await tx.query(`SET LOCAL TIME ZONE 'Asia/Taipei'`);
      await appendAudit(tx, { action: 'ledger.entry' });
    });
    const canonical = await withTx(orgCtx(orgId), async (tx) => (await tx.query<{ canonical: string }>('SELECT canonical FROM audit.events')).rows[0].canonical);
    expect(JSON.parse(canonical).at).toMatch(/Z$/);
    expect(await withTx(orgCtx(orgId), (tx) => verifyChain(tx))).toMatchObject({ ok: true, count: 1 });
  });

  it('operator 脈絡的存取紀錄寫在目標組織的鏈', async () => {
    await withTx({ kind: 'operator', operatorId: OPERATOR_X, orgId: ORG_B, ticketId: 'CASE-9' }, async () => undefined);
    const rows = await withTx(orgCtx(ORG_B), async (tx) => (await tx.query<{ action: string; payload: { ticket: string } }>('SELECT action, payload FROM audit.events')).rows);
    expect(rows).toEqual([{ action: 'operator.access', payload: { ticket: 'CASE-9' } }]);
  });

  it('超級使用者關閉觸發器改欄位：verifyChain 抓到', async () => {
    const orgId = '01JBKQ00000000000000000F01';
    for (let i = 0; i < 3; i++) await withTx(orgCtx(orgId), (tx) => appendAudit(tx, { action: 'ledger.entry' }));
    await admin.query('ALTER TABLE audit.events DISABLE TRIGGER USER');
    try {
      await admin.query(`UPDATE audit.events SET action = 'member.grant' WHERE chain_id = $1 AND seq = 2`, [orgId]);
    } finally {
      await admin.query('ALTER TABLE audit.events ENABLE TRIGGER USER');
    }
    const report = await withTx(orgCtx(orgId), (tx) => verifyChain(tx));
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.kind)).toEqual(['canonical_mismatch']);
  });

  it('break_glass 的使用紀錄：只有 break_glass 能呼叫，行為者是登入身分', async () => {
    await expect(withTx({ kind: 'control' }, (tx) => tx.query(`SELECT audit.record_break_glass('start', 'INC-1', 'x')`))).rejects.toThrow(/permission denied/);
    await admin.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, '甲組織', 'owner') ON CONFLICT DO NOTHING`, [ORG_A]);
    await admin.query('SET ROLE break_glass');
    try {
      await admin.query(`SELECT audit.record_break_glass('start', 'INC-7', '修復資料', $1)`, [ORG_A]);
    } finally {
      await admin.query('RESET ROLE');
    }
    const rows = await withTx(orgCtx(ORG_A), async (tx) =>
      (await tx.query<{ action: string; actor_type: string; actor_id: string }>(`SELECT action, actor_type, actor_id FROM audit.events WHERE split_part(action, '.', 1) = 'break_glass'`)).rows,
    );
    expect(rows).toEqual([{ action: 'break_glass.start', actor_type: 'break_glass', actor_id: (await admin.query('SELECT session_user AS u')).rows[0].u }]);
  });
});
