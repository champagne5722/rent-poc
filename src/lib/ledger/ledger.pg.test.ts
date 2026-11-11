import { Client, type Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgDriver } from '../pg/drivers';
import { fromPgClient } from '../pg/executor';
import { migrate } from '../pg/migrate';
import { closeTestPool, createTestPool, dropTestDatabase } from '../pg/pg-database-kit';
import { withClusterLock } from '../pg/pg-test-support';
import { seedCases, testCaseId } from '../pg/test-cases';
import { MIGRATIONS_DIR } from '../pg/test-harness';
import { newUlid } from '../pg/ulid';
import { createWithTx, type OrgTx, type WithTx } from '../pg/with-tx';
import { postJournal, reverseJournal } from './post';

// MIL-117 在真實 PostgreSQL 的驗證：pg 驅動（bigint 回傳字串）、真正的角色與登入、
// 併發寫入、觸發器對超級使用者與擁有者生效（ADR-0015 決議 13、Action Item 1）。
// 只在有 TEST_DATABASE_URL 時執行，說明見 src/lib/pg/pg-integration.test.ts。

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('鏡像帳：真實 PostgreSQL', () => {
  const dbName = `ledger_${Math.random().toString(36).slice(2, 10)}`;
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
  const orgA = newUlid();
  const orgB = newUlid();
  // 鏡像帳的 case_id 掛了 org.cases 的複合外鍵（MIL-123）。org.cases.id 全域唯一，所以兩個組織各有自己的案件
  const CASE_A = testCaseId('CASEA1');
  const CASE_B = testCaseId('CASEB1');

  const receipt = (over: Record<string, unknown> = {}) => ({
    eventType: 'receipt_confirmed',
    eventId: newUlid(),
    caseId: CASE_A,
    effectiveDate: '2026-11-08',
    payload: { paymentAccountId: 'PA1', deposit: 60000, rent: 30000 },
    ...over,
  });

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
    await admin.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'A', 'owner'), ($2, 'B', 'owner')`, [orgA, orgB]);
    pool = createTestPool({ connectionString: urlFor('app_rw', 'rw-test', dbName), max: 8 });
    withTx = createWithTx(pgDriver(pool));
    await seedCases(withTx, [orgA], [CASE_A]);
    await seedCases(withTx, [orgB], [CASE_B]);
  });
  afterAll(async () => {
    await closeTestPool(pool);
    await admin.end();
    await dropTestDatabase(adminUrl!, dbName);
  });

  const inOrg = <T>(orgId: string, fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId }, fn);

  it('寫入與沖銷：pg 驅動回傳的 bigint 字串能正確轉換', async () => {
    const posted = await inOrg(orgA, (tx) => postJournal(tx, receipt()));
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;
    const reversed = await inOrg(orgA, (tx) =>
      reverseJournal(tx, { journalId: posted.value.journalId, eventId: newUlid(), reason: '登錯', effectiveDate: '2026-11-09' }),
    );
    expect(reversed.ok).toBe(true);
    if (reversed.ok) expect(reversed.value.lines.map((l) => [l.debit, l.credit])).toEqual([[0, 90000], [60000, 0], [30000, 0]]);
  });

  it('app_rw 的 UPDATE、DELETE、TRUNCATE 被擋下；超級使用者與擁有者被觸發器擋下', async () => {
    const statements = ['UPDATE org.ledger_entries SET debit = debit + 1', 'DELETE FROM org.ledger_entries', 'TRUNCATE org.ledger_journals, org.ledger_entries, org.receipt_confirmations, org.deposit_holder_acknowledgments'];
    for (const sql of statements) {
      await expect(inOrg(orgA, (tx) => tx.query(sql)), sql).rejects.toThrow(/permission denied/);
      await expect(admin.query(sql), sql).rejects.toThrow(/只增不改/);
    }
    await admin.query('SET ROLE app_owner');
    try {
      await expect(admin.query('TRUNCATE org.ledger_journals, org.ledger_entries, org.receipt_confirmations, org.deposit_holder_acknowledgments')).rejects.toThrow(/只增不改/);
      expect((await admin.query('UPDATE org.ledger_entries SET debit = debit + 1')).rowCount).toBe(0);
    } finally {
      await admin.query('RESET ROLE');
    }
  });

  it('不平衡分錄在提交時被擋下；提交前切換組織脈絡也被擋下', async () => {
    const insertSql = (orgId: string, journalId: string, credit: number) => [
      `INSERT INTO org.ledger_journals (id, org_id, case_id, business_event_type, business_event_id, effective_date)
       VALUES ($1, $2, $4, 'receipt_confirmed', $3, '2026-11-08')`,
      [journalId, orgId, newUlid(), CASE_A],
      `INSERT INTO org.ledger_entries (id, org_id, case_id, journal_id, line_no, account, debit, credit) VALUES
         ($1, $2, $5, $3, 1, 'asset.bank.PA1', 100, 0), ($4, $2, $5, $3, 2, $6, 0, ${credit})`,
      [newUlid(), orgId, journalId, newUlid(), CASE_A, `liability.deposit.${CASE_A}`],
    ] as const;
    const run = async (credit: number, switchTo?: string) =>
      inOrg(orgA, async (tx) => {
        const journalId = newUlid();
        const [j, jp, e, ep] = insertSql(orgA, journalId, credit);
        await tx.query(j, [...jp]);
        await tx.query(e, [...ep]);
        if (switchTo !== undefined) await tx.query(`SELECT set_config('app.org_id', $1, true)`, [switchTo]);
      });
    await expect(run(99)).rejects.toThrow(/借貸不平衡/);
    await expect(run(99, orgB)).rejects.toThrow(/組織脈絡/);
    await expect(run(100, orgB)).rejects.toThrow(/組織脈絡/);
    await expect(run(100)).resolves.toBeUndefined();
  });

  it('併發：同一筆分錄 10 個交易同時沖銷，恰好 1 個成功，其餘回傳 already_reversed', async () => {
    const posted = await inOrg(orgA, (tx) => postJournal(tx, receipt()));
    if (!posted.ok) throw new Error('測試資料寫入失敗');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        inOrg(orgA, (tx) => reverseJournal(tx, { journalId: posted.value.journalId, eventId: `REV-CONC-${i}`, reason: '併發', effectiveDate: '2026-11-09' })),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results.filter((r) => !r.ok)) {
      if (!r.ok) expect(r.errors.map((e) => e.code)).toEqual(['already_reversed']);
    }
  });

  it('併發：同一個業務事件 ID 10 個交易同時寫入，恰好 1 個成功，其餘回傳 duplicate_event', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => inOrg(orgA, (tx) => postJournal(tx, receipt({ eventId: 'CONCURRENT-EVENT' })))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results.filter((r) => !r.ok)) {
      if (!r.ok) expect(r.errors.map((e) => e.code)).toEqual(['duplicate_event']);
    }
  });

  it('併發：不同組織同時寫入互不影響，各自只看得到自己的分錄', async () => {
    await Promise.all([
      ...Array.from({ length: 5 }, () => inOrg(orgA, (tx) => postJournal(tx, receipt()))),
      ...Array.from({ length: 5 }, () => inOrg(orgB, (tx) => postJournal(tx, receipt({ caseId: CASE_B })))),
    ]);
    const countFor = async (orgId: string, caseId: string) =>
      (await inOrg(orgId, (tx) => tx.query<{ n: number }>('SELECT count(*)::int AS n FROM org.ledger_journals WHERE case_id = $1', [caseId]))).rows[0].n;
    expect(await countFor(orgB, CASE_B)).toBe(5);
    expect(await countFor(orgA, CASE_A)).toBeGreaterThanOrEqual(5);
    // 看不到別的組織的案件：A 的脈絡查 B 的案件是 0 列
    expect(await countFor(orgA, CASE_B)).toBe(0);
  });
});
