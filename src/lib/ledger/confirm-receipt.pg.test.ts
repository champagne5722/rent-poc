import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openCaseLedger } from '../case-ledger';
import { registerPaymentAccount } from '../payment-accounts';
import { pgDriver } from '../pg/drivers';
import { fromPgClient } from '../pg/executor';
import { migrate } from '../pg/migrate';
import { withClusterLock } from '../pg/pg-test-support';
import { MIGRATIONS_DIR } from '../pg/test-harness';
import { seedOrgMember } from '../pg/test-parties';
import { newUlid } from '../pg/ulid';
import { createWithTx, type OrgTx, type WithTx } from '../pg/with-tx';
import { confirmReceipt } from './confirm-receipt';
import { listPeriodViews, listReceipts } from './receipt-reads';
import type { ReceiptCandidate } from './receipt-types';

// MIL-125 在真實 PostgreSQL 的驗證：同一案件的入帳一次一筆（FOR UPDATE 鎖押金台帳），
// 同時送出的相同請求只入帳一次，同時送出的不同請求不會把同一期別配超過應收金額。
// PGlite 只有單一連線，測不到這些。只在有 TEST_DATABASE_URL 時執行，說明見 src/lib/pg/pg-integration.test.ts。

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('入帳確認：真實 PostgreSQL 併發', () => {
  const dbName = `receipt_${Math.random().toString(36).slice(2, 10)}`;
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
  let accountId = '';
  let partyId = '';

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
    await admin.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'A', 'owner')`, [orgA]);
    pool = new Pool({ connectionString: urlFor('app_rw', 'rw-test', dbName), max: 8 });
    withTx = createWithTx(pgDriver(pool));
    partyId = await seedOrgMember(withTx, orgA);
    const registered = await inOrg((tx) =>
      registerPaymentAccount(tx, { name: '帳戶', holderKind: 'lessor', holderName: '某人', method: 'bank', bankCode: '812', accountLast4: '0123' }, partyId),
    );
    if (!registered.ok) throw new Error('登錄帳戶失敗');
    accountId = registered.id;
  });
  afterAll(async () => {
    await pool.end();
    await admin.end();
    const root = new Client({ connectionString: adminUrl });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  const inOrg = <T>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: orgA }, fn);

  async function newCase(): Promise<string> {
    const caseId = newUlid();
    await inOrg(async (tx) => {
      await tx.query(
        `INSERT INTO org.cases (id, org_id, kind, state, business_type, title) VALUES ($1, $2, 'lease', 'active', 'self_managed', '併發測試')`,
        [caseId, orgA],
      );
      await openCaseLedger(tx, caseId, { deposit: 60000, startDate: '2026-11-01', endDate: '2027-01-31', payDay: 5, rent: 30000 });
    });
    return caseId;
  }

  const candidate = (caseId: string, over: Partial<ReceiptCandidate> = {}): ReceiptCandidate => ({
    source: 'manual',
    externalId: newUlid(),
    caseId,
    purpose: 'rent',
    amount: 30000,
    valueDate: '2026-11-08',
    paymentAccountId: accountId,
    recordedByPartyId: partyId,
    onBehalf: false,
    ...over,
  });

  it('同一個去重鍵同時送出 8 次：只入帳一次，其餘回傳原本那筆', async () => {
    const caseId = await newCase();
    const c = candidate(caseId);
    const results = await Promise.all(Array.from({ length: 8 }, () => inOrg((tx) => confirmReceipt(tx, c))));
    expect(results.every((r) => r.ok)).toBe(true);
    const created = results.filter((r) => r.ok && !r.duplicate);
    expect(created).toHaveLength(1);
    const ids = new Set(results.map((r) => (r.ok ? r.confirmation.id : '')));
    expect(ids.size).toBe(1);
    const receipts = await inOrg((tx) => listReceipts(tx, caseId));
    expect(receipts).toHaveLength(1);
    const journals = await admin.query(`SELECT count(*)::int AS n FROM org.ledger_journals WHERE case_id = $1`, [caseId]);
    expect(journals.rows[0].n).toBe(1);
  });

  it('同一案件同時送出 10 筆不同的入帳：期別不超配，配置合計等於入帳合計', async () => {
    const caseId = await newCase();
    // 10 筆 12000，共 120000：三期 90000 付滿，其餘 30000 是預收
    const results = await Promise.all(Array.from({ length: 10 }, () => inOrg((tx) => confirmReceipt(tx, candidate(caseId, { amount: 12000 })))));
    expect(results.every((r) => r.ok)).toBe(true);
    const periods = await inOrg((tx) => listPeriodViews(tx, caseId));
    expect(periods.map((p) => [p.periodKey, p.status, p.allocated])).toEqual([
      ['2026-11', 'paid', 30000],
      ['2026-12', 'paid', 30000],
      ['2027-01', 'paid', 30000],
    ]);
    const prepaid = results.reduce((sum, r) => sum + (r.ok ? r.prepaid : 0), 0);
    expect(prepaid).toBe(30000);
    const balance = await admin.query(
      `SELECT sum(credit - debit)::int AS n FROM org.ledger_entries WHERE case_id = $1 AND account = 'liability.prepaid_rent.' || $1`,
      [caseId],
    );
    expect(balance.rows[0].n).toBe(30000);
  });

  it('入帳失敗時整筆回滾：外鍵擋下後，分錄也不留', async () => {
    const caseId = await newCase();
    await expect(inOrg((tx) => confirmReceipt(tx, candidate(caseId, { recordedByPartyId: newUlid() })))).rejects.toThrow();
    const journals = await admin.query(`SELECT count(*)::int AS n FROM org.ledger_journals WHERE case_id = $1`, [caseId]);
    expect(journals.rows[0].n).toBe(0);
  });

  it('app_rw 不能改入帳確認與持有人確認紀錄；擁有者與超級使用者被觸發器擋下', async () => {
    const caseId = await newCase();
    const done = await inOrg((tx) => confirmReceipt(tx, candidate(caseId)));
    expect(done.ok).toBe(true);
    for (const sql of ['UPDATE org.receipt_confirmations SET amount = 1', 'DELETE FROM org.receipt_confirmations']) {
      await expect(inOrg((tx) => tx.query(sql)), sql).rejects.toThrow(/permission denied/);
      await expect(admin.query(sql), sql).rejects.toThrow(/只增不改|row-level|不得/);
    }
  });
});
