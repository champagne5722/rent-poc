import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgDriver } from '../../pg/drivers';
import { fromPgClient } from '../../pg/executor';
import { migrate } from '../../pg/migrate';
import { withClusterLock } from '../../pg/pg-test-support';
import { MIGRATIONS_DIR } from '../../pg/test-harness';
import { createWithTx, type WithTx } from '../../pg/with-tx';
import { appendAudit } from '../append';
import { orgCtx } from '../audit-test-kit';
import { runAnchorAudit } from './anchor-audit';
import { memoryLogger, NOW } from './anchor-test-kit';
import { createMockAnchorProvider } from './mock-provider';
import { runVerifyAudit } from './verify-audit';

// MIL-88 在真實 PostgreSQL 的驗證：pg 驅動（bigint 與 timestamptz 的型別轉換）、
// 兩個排程真的同時跑（pg_advisory_xact_lock 與 AU001）、app_rw 的實際權限。
// 只在有 TEST_DATABASE_URL 時執行，說明見 pg-integration.test.ts。
// MIL-88 完成時 Docker 沒有啟動，這個檔案沒有在真實 PostgreSQL 跑過，只過了型別與 lint 檢查。

const adminUrl = process.env.TEST_DATABASE_URL;
const ORG_A = '01JBKQ00000000000000000A01';
const ORG_B = '01JBKQ00000000000000000B01';

describe.skipIf(!adminUrl)('稽核鏈錨定：真實 PostgreSQL', () => {
  const dbName = `anchor_${Math.random().toString(36).slice(2, 10)}`;
  const urlFor = (user: string, password: string, db: string) => {
    const u = new URL(adminUrl!);
    u.username = user;
    u.password = password;
    u.pathname = `/${db}`;
    return u.toString();
  };
  let admin: Client;
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
    await withClusterLock(adminUrl!, async () => {
      await migrate(fromPgClient(admin), { dir: MIGRATIONS_DIR, runAs: 'app_owner' });
      await admin.query(`ALTER ROLE app_rw PASSWORD 'rw-test'`);
    });
    await admin.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, '甲組織', 'owner'), ($2, '乙組織', 'owner')`, [ORG_A, ORG_B]);
    pool = new Pool({ connectionString: urlFor('app_rw', 'rw-test', dbName), max: 5 });
    withTx = createWithTx(pgDriver(pool));
  });
  afterAll(async () => {
    await pool.end();
    await admin.end();
    const root = new Client({ connectionString: adminUrl });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  const write = (orgId: string, n: number) =>
    withTx(orgCtx(orgId), async (tx) => {
      for (let i = 0; i < n; i++) await appendAudit(tx, { action: 'ledger.entry' });
    });

  it('錨定、驗證一輪：pg 驅動回傳的字串型別都轉得對', async () => {
    await write(ORG_A, 3);
    await write(ORG_B, 2);
    const provider = createMockAnchorProvider({ now: () => NOW });
    const logger = memoryLogger();

    expect(await runAnchorAudit({ withTx, provider, logger }, NOW)).toMatchObject({ status: 'anchored', chains: 2 });
    expect(await runAnchorAudit({ withTx, provider, logger }, NOW)).toEqual({ status: 'no_changes' });

    const result = await runVerifyAudit({ withTx, providers: { mock: provider }, logger }, NOW);
    expect(result).toMatchObject({ failed: [], errors: 0, anchorsChecked: 2 });
    expect(logger.entries).toEqual([]);
  });

  it('兩個排程同時執行：只有一批被保存，另一個回報 superseded，不留重複的葉', async () => {
    await write(ORG_A, 1);
    const provider = createMockAnchorProvider({ now: () => NOW });
    const logger = memoryLogger();
    const outcomes = await Promise.all([1, 2, 3].map(() => runAnchorAudit({ withTx, provider, logger }, NOW)));

    const statuses = outcomes.map((o) => o.status).sort();
    expect(statuses.filter((s) => s === 'anchored')).toHaveLength(1);
    expect(statuses.every((s) => s === 'anchored' || s === 'superseded' || s === 'no_changes')).toBe(true);
    // 同一個資料庫裡前面的測試也寫過這條鏈，所以比對目前的鏈頭序號，不寫死 1
    const { rows } = await admin.query(
      `SELECT count(*)::int AS n FROM audit.anchor_leaves l
        WHERE l.chain_id = $1 AND l.seq = (SELECT h.seq FROM audit.chain_heads h WHERE h.chain_id = $1)`,
      [ORG_A],
    );
    expect(rows[0].n).toBe(1);
  });

  it('app_rw 不能直接讀寫錨定表，但能呼叫定義者函式', async () => {
    const direct = pool.query('SELECT * FROM audit.anchor_batches');
    await expect(direct).rejects.toThrow(/permission denied/);
    const { rows } = await pool.query('SELECT * FROM audit.unanchored_heads()');
    expect(Array.isArray(rows)).toBe(true);
  });

  it('超級使用者重算整條鏈後，verify-audit 比對回執發現不一致', async () => {
    const orgId = '01JBKQ00000000000000000C01';
    await admin.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, '丙組織', 'owner')`, [orgId]);
    await write(orgId, 3);
    const provider = createMockAnchorProvider({ now: () => NOW });
    const logger = memoryLogger();
    await runAnchorAudit({ withTx, provider, logger }, NOW);

    // 竄改第 2 筆的動作並重算之後每一筆與鏈頭
    await admin.query('ALTER TABLE audit.events DISABLE TRIGGER USER');
    try {
      const { rows } = await admin.query<{ seq: string; canonical: string }>(`SELECT seq::text AS seq, canonical FROM audit.events WHERE chain_id = $1 ORDER BY seq`, [orgId]);
      let prev = '0'.repeat(64);
      for (const row of rows) {
        const canonical = row.seq === '2' ? row.canonical.replace('ledger.entry', 'member.grant') : row.canonical;
        const { rows: h } = await admin.query<{ h: string }>(`SELECT encode(sha256(convert_to($1, 'UTF8')), 'hex') AS h`, [prev + canonical]);
        await admin.query(
          `UPDATE audit.events SET canonical = $1, prev_hash = $2, hash = $3, action = CASE WHEN seq = 2 THEN 'member.grant' ELSE action END WHERE chain_id = $4 AND seq = $5`,
          [canonical, prev, h[0].h, orgId, Number(row.seq)],
        );
        prev = h[0].h;
      }
      await admin.query(`UPDATE audit.chain_heads SET head_hash = $1 WHERE chain_id = $2`, [prev, orgId]);
    } finally {
      await admin.query('ALTER TABLE audit.events ENABLE TRIGGER USER');
    }

    const result = await runVerifyAudit({ withTx, providers: { mock: provider }, logger }, NOW);
    expect(result.failed).toContainEqual({ chainId: orgId, local: [], anchors: ['anchored_hash_mismatch@3'] });
    expect(logger.of('CRITICAL').length).toBeGreaterThanOrEqual(1);
  });
});
