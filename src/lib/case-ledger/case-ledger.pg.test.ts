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
import { openCaseLedger } from './open';
import { getDepositBalance, getDepositLedger, listPeriods } from './reads';

// MIL-123 在真實 PostgreSQL 的驗證（ADR-0015 決議 12、Action Item 1）：
// 1. 複合外鍵與 NOT VALID 在真實 PostgreSQL 的行為。
// 2. 案件成員政策與 security_invoker 的 view：真實 PostgreSQL 的 RLS 與 PGlite 可能不同，這是案件政策函式的第二次驗證。
// 3. 併發：同一案件 10 個交易同時建立押金台帳，恰好 1 個成功建立，其餘回 already_open，期別不重複。
// 只在有 TEST_DATABASE_URL 時執行，說明見 src/lib/pg/pg-integration.test.ts。

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('接上案件的帳務：真實 PostgreSQL', () => {
  const dbName = `caseledger_${Math.random().toString(36).slice(2, 10)}`;
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
  const lessee = newUlid();
  const outsider = newUlid();
  const CASE_A = testCaseId('CASEA1');
  const CASE_A2 = testCaseId('CASEA2');
  const CASE_B = testCaseId('CASEB1');
  const terms = { deposit: 60000, startDate: '2026-11-01', endDate: '2027-01-31', payDay: 5, rent: 30000 };

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
    await admin.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'A', 'practice'), ($2, 'B', 'owner')`, [orgA, orgB]);
    await admin.query(
      `INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'lessee@example.com', '承租人'), ($2, 'outsider@example.com', '路人')`,
      [lessee, outsider],
    );
    pool = createTestPool({ connectionString: urlFor('app_rw', 'rw-test', dbName), max: 12 });
    withTx = createWithTx(pgDriver(pool));
    await seedCases(withTx, [orgA], [CASE_A, CASE_A2]);
    await seedCases(withTx, [orgB], [CASE_B]);
    await withTx({ kind: 'org', orgId: orgA }, async (tx) => {
      await tx.query(`INSERT INTO org.case_members (id, org_id, case_id, party_id, relation) VALUES ($1, $2, $3, $4, 'lessee')`, [
        newUlid(),
        orgA,
        CASE_A,
        lessee,
      ]);
    });
  });
  afterAll(async () => {
    await closeTestPool(pool);
    await admin.end();
    await dropTestDatabase(adminUrl!, dbName);
  });

  const inOrg = <T>(orgId: string, fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId }, fn);

  async function postDeposit(tx: OrgTx, orgId: string, caseId: string, eventId: string, amount: number): Promise<void> {
    const journalId = newUlid();
    await tx.query(
      `INSERT INTO org.ledger_journals (id, org_id, case_id, business_event_type, business_event_id, effective_date)
       VALUES ($1, $2, $3, 'receipt_confirmed', $4, '2026-11-08')`,
      [journalId, orgId, caseId, eventId],
    );
    await tx.query(
      `INSERT INTO org.ledger_entries (id, org_id, case_id, journal_id, line_no, account, debit, credit) VALUES
         ($1, $2, $3, $4, 1, 'asset.bank.PA1', $7, 0), ($5, $2, $3, $4, 2, $6, 0, $7)`,
      [newUlid(), orgId, caseId, journalId, newUlid(), `liability.deposit.${caseId}`, amount],
    );
  }

  it('複合外鍵：分錄的案件必須存在且屬於同一個組織', async () => {
    await expect(inOrg(orgA, (tx) => postDeposit(tx, orgA, testCaseId('MXSSNG'), 'FK-1', 100))).rejects.toThrow(/foreign key/i);
    await expect(inOrg(orgA, (tx) => postDeposit(tx, orgA, CASE_B, 'FK-2', 100))).rejects.toThrow(/foreign key/i);
    await expect(inOrg(orgA, (tx) => postDeposit(tx, orgA, CASE_A, 'FK-3', 100))).resolves.toBeUndefined();
    const { rows } = await admin.query<{ convalidated: boolean }>(`SELECT convalidated FROM pg_constraint WHERE conname = 'ledger_journals_case_fk'`);
    expect(rows).toEqual([{ convalidated: false }]);
  });

  it('押金餘額 view：security_invoker 生效，承租人只看到自己案件，路人與別的組織看不到', async () => {
    await inOrg(orgA, async (tx) => {
      await postDeposit(tx, orgA, CASE_A, 'BAL-1', 60000);
      await postDeposit(tx, orgA, CASE_A2, 'BAL-2', 30000);
    });
    const { rows: opts } = await admin.query<{ reloptions: string[] | null }>(`SELECT reloptions FROM pg_class WHERE oid = 'org.deposit_balances'::regclass`);
    expect(opts[0].reloptions).toContain('security_invoker=true');

    expect(await inOrg(orgA, (tx) => getDepositBalance(tx, CASE_A))).toBe(60100);
    expect(await inOrg(orgA, (tx) => getDepositBalance(tx, CASE_A2))).toBe(30000);
    expect(await inOrg(orgB, (tx) => getDepositBalance(tx, CASE_A))).toBe(0);
    const asLessee = await withTx({ kind: 'party', partyId: lessee }, (tx) => tx.query<{ case_id: string }>('SELECT case_id FROM org.deposit_balances ORDER BY case_id'));
    expect(asLessee.rows.map((r) => r.case_id)).toEqual([CASE_A]);
    const asOutsider = await withTx({ kind: 'party', partyId: outsider }, (tx) => tx.query('SELECT 1 FROM org.deposit_balances'));
    expect(asOutsider.rows).toEqual([]);
  });

  it('案件成員政策：承租人讀得到押金台帳與分錄，讀不到應收期別與匯款識別', async () => {
    await inOrg(orgA, async (tx) => {
      await openCaseLedger(tx, CASE_A2, terms);
      await tx.query(`INSERT INTO org.case_remitter_ids (id, org_id, case_id, kind, value) VALUES ($1, $2, $3, 'account_last5', '12345')`, [newUlid(), orgA, CASE_A]);
    });
    const count = (table: string) =>
      withTx({ kind: 'party', partyId: lessee }, (tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE case_id = $1`, [CASE_A]));
    await inOrg(orgA, (tx) => openCaseLedger(tx, CASE_A, terms));
    expect((await count('org.ledger_journals')).rows[0].n).toBeGreaterThan(0);
    expect((await count('org.deposit_ledgers')).rows[0].n).toBe(1);
    expect((await count('org.receivable_periods')).rows[0].n).toBe(0);
    expect((await count('org.case_remitter_ids')).rows[0].n).toBe(0);
  });

  it('併發：同一案件 10 個交易同時開立，恰好 1 個成功，期別不重複', async () => {
    const caseId = testCaseId('CASEC1');
    await seedCases(withTx, [orgA], [caseId]);
    const results = await Promise.all(Array.from({ length: 10 }, () => inOrg(orgA, (tx) => openCaseLedger(tx, caseId, terms))));
    expect(results.filter((r) => r.opened)).toHaveLength(1);
    for (const r of results.filter((r) => !r.opened)) expect(r).toEqual({ opened: false, reason: 'already_open' });
    expect(await inOrg(orgA, (tx) => getDepositLedger(tx, caseId))).toMatchObject({ expectedAmount: 60000 });
    expect((await inOrg(orgA, (tx) => listPeriods(tx, caseId))).map((p) => p.periodKey)).toEqual(['2026-11', '2026-12', '2027-01']);
  });

  it('應收期別與押金台帳：app_rw 的 UPDATE 受觸發器限制，超級使用者與擁有者也一樣', async () => {
    const caseId = testCaseId('CASED1');
    await seedCases(withTx, [orgA], [caseId]);
    await inOrg(orgA, (tx) => openCaseLedger(tx, caseId, terms));
    await expect(inOrg(orgA, (tx) => tx.query(`UPDATE org.receivable_periods SET amount = 1 WHERE case_id = $1`, [caseId]))).rejects.toThrow(/不得修改/);
    await expect(inOrg(orgA, (tx) => tx.query(`DELETE FROM org.deposit_ledgers WHERE case_id = $1`, [caseId]))).rejects.toThrow(/不得刪除/);
    await expect(admin.query('TRUNCATE org.receivable_periods, org.receipt_allocations')).rejects.toThrow(/不得刪除/);
    await expect(inOrg(orgA, (tx) => tx.query('TRUNCATE org.case_social_housing_changes'))).rejects.toThrow(/permission denied/);
  });
});
