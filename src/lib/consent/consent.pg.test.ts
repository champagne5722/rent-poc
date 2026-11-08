import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORG_A, ORG_B, orgCtx } from '../audit/audit-test-kit';
import { verifyChain } from '../audit';
import { pgDriver } from '../pg/drivers';
import { fromPgClient } from '../pg/executor';
import { migrate } from '../pg/migrate';
import { withClusterLock } from '../pg/pg-test-support';
import { MIGRATIONS_DIR } from '../pg/test-harness';
import { createWithTx, type WithTx } from '../pg/with-tx';
import { latestConsent, recordConsent } from './index';

// MIL-84 在真實 PostgreSQL 的驗證：pg 驅動（bigint 回傳字串、timestamptz 回傳 Date）、
// 真正的角色與登入、併發寫入、觸發器對 superuser 與擁有者生效。
// 只在有 TEST_DATABASE_URL 時執行，說明見 pg-integration.test.ts。

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('同意紀錄：真實 PostgreSQL', () => {
  const dbName = `consent_${Math.random().toString(36).slice(2, 10)}`;
  const urlFor = (user: string, password: string, db: string) => {
    const u = new URL(adminUrl!);
    u.username = user;
    u.password = password;
    u.pathname = `/${db}`;
    return u.toString();
  };
  let admin: Client; // 管理者身分，模擬超級使用者
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

  const subject = { email: 'tenant@example.com' };

  it('寫入與查詢：pg 驅動的 bigint 與時間型別正確對應，鏈驗證通過', async () => {
    const rec = await withTx(orgCtx(ORG_A), (tx) =>
      recordConsent(tx, { notice: 'esign', subject, decision: 'agree', source: 'in_app', relatedTo: { type: 'contract', id: 'c1' } }),
    );
    expect(rec.audit).toEqual({ chainId: ORG_A, seq: 1 });
    expect(rec.recordedAt).toBeInstanceOf(Date);
    const latest = await withTx(orgCtx(ORG_A), (tx) => latestConsent(tx, { notice: 'esign', subject }));
    expect(latest).toMatchObject({ id: rec.id, decision: 'agree', noticeVersion: 1, isCurrentVersion: true });
    const report = await withTx(orgCtx(ORG_A), (tx) => verifyChain(tx));
    expect(report.ok).toBe(true);
  });

  it('app_rw 的權限、RLS 與觸發器：UPDATE、DELETE、TRUNCATE 被擋下，B 看不到 A', async () => {
    for (const sql of ["UPDATE org.consent_records SET decision = 'agree'", 'DELETE FROM org.consent_records', 'TRUNCATE org.consent_records']) {
      await expect(withTx(orgCtx(ORG_A), (tx) => tx.query(sql)), sql).rejects.toThrow(/permission denied/);
    }
    for (const sql of ["UPDATE org.consent_records SET decision = 'agree'", 'DELETE FROM org.consent_records', 'TRUNCATE org.consent_records']) {
      await expect(admin.query(sql), sql).rejects.toThrow(/同意紀錄只增不改/);
    }
    await admin.query('SET ROLE app_owner');
    try {
      await expect(admin.query('TRUNCATE org.consent_records')).rejects.toThrow(/同意紀錄只增不改/);
      // FORCE RLS 下擁有者沒有政策，看不到列：UPDATE 與 DELETE 影響 0 列，資料不變
      expect((await admin.query("UPDATE org.consent_records SET decision = 'object'")).rowCount).toBe(0);
      expect((await admin.query('DELETE FROM org.consent_records')).rowCount).toBe(0);
    } finally {
      await admin.query('RESET ROLE');
    }
    expect(await withTx(orgCtx(ORG_B), (tx) => latestConsent(tx, { notice: 'esign', subject }))).toBeNull();
    const none = await withTx({ kind: 'control' }, async (tx) => (await tx.query('SELECT 1 FROM org.consent_records')).rows);
    expect(none).toEqual([]);
  });

  it('併發：同一個組織 10 筆同時寫，每筆都有各自的稽核序號，鏈驗證通過，最新是序號最大的那筆', async () => {
    const orgId = '01JBKQ00000000000000000C02';
    const recs = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        withTx(orgCtx(orgId), (tx) =>
          recordConsent(tx, { notice: 'certificate_pii', subject: { email: `p${i}@example.com` }, decision: i % 2 === 0 ? 'agree' : 'object', source: 'in_app' }),
        ),
      ),
    );
    expect(recs.map((r) => r.audit.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    expect((await withTx(orgCtx(orgId), (tx) => verifyChain(tx))).ok).toBe(true);
  });

  it('回滾：同意紀錄與稽核事件一起消失', async () => {
    const orgId = '01JBKQ00000000000000000C03';
    await expect(
      withTx(orgCtx(orgId), async (tx) => {
        await recordConsent(tx, { notice: 'esign', subject, decision: 'agree', source: 'in_app' });
        throw new Error('後續失敗');
      }),
    ).rejects.toThrow('後續失敗');
    const counts = await withTx(orgCtx(orgId), async (tx) => ({
      consent: (await tx.query('SELECT 1 FROM org.consent_records')).rows.length,
      audit: (await tx.query('SELECT 1 FROM audit.events')).rows.length,
    }));
    expect(counts).toEqual({ consent: 0, audit: 0 });
  });
});
