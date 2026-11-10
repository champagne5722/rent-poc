import type { PGliteInterface } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pgliteDriver } from './drivers';
import { seedCases, testCaseId } from './test-cases';
import { asRole, createTestDb, type TestDb } from './test-harness';
import { newUlid } from './ulid';
import { createWithTx, type OrgTx, type WithTx } from './with-tx';

// MIL-125：migration 0075 的資料庫約束。寫入都從 app_rw 發出，用原始 SQL，測的是資料庫自己的防線。
// 讀取政策的逐關係矩陣在 case-rls.test.ts，滲透探測在 rls-penetration.test.ts，這裡不重複。

const CASE_A = testCaseId('CASEA1');
const CASE_A2 = testCaseId('CASEA2');
const CASE_B = testCaseId('CASEB1');

describe('入帳確認、配置與持有人確認紀錄的表與約束（0075）', () => {
  let testDb: TestDb;
  let db: PGliteInterface;
  let withTx: WithTx;
  const orgA = newUlid();
  const orgB = newUlid();

  beforeAll(async () => {
    testDb = await createTestDb();
  });
  afterAll(() => testDb.close());

  beforeEach(async () => {
    db = await testDb.fresh();
    withTx = createWithTx(pgliteDriver(db));
    await asRole(db, 'app_owner', async () => {
      await db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'A', 'owner'), ($2, 'B', 'owner')`, [orgA, orgB]);
    });
    await seedCases(withTx, [orgA], [CASE_A, CASE_A2]);
    await seedCases(withTx, [orgB], [CASE_B]);
  });

  const inOrg = <T>(orgId: string, fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId }, fn);
  const inA = <T>(fn: (tx: OrgTx) => Promise<T>) => inOrg(orgA, fn);

  it('控制組：測試連線是 app_rw', async () => {
    expect((await db.query<{ u: string }>('SELECT current_user AS u')).rows[0].u).toBe('app_rw');
  });

  async function newAccount(tx: OrgTx, orgId: string): Promise<string> {
    const id = newUlid();
    await tx.query(
      `INSERT INTO org.payment_accounts (id, org_id, name, holder_kind, holder_name, account_kind, bank_code, account_last4)
       VALUES ($1, $2, '帳戶', 'other', '某人', 'general', '812', '0123')`,
      [id, orgId],
    );
    return id;
  }

  async function newJournal(tx: OrgTx, orgId: string, caseId: string, eventId: string): Promise<string> {
    const journalId = newUlid();
    await tx.query(
      `INSERT INTO org.ledger_journals (id, org_id, case_id, business_event_type, business_event_id, effective_date)
       VALUES ($1, $2, $3, 'receipt_confirmed', $4, '2026-11-08')`,
      [journalId, orgId, caseId, eventId],
    );
    await tx.query(
      `INSERT INTO org.ledger_entries (id, org_id, case_id, journal_id, line_no, account, debit, credit) VALUES
         ($1, $2, $3, $4, 1, 'asset.bank.PA1', 100, 0), ($5, $2, $3, $4, 2, $6, 0, 100)`,
      [newUlid(), orgId, caseId, journalId, newUlid(), `liability.deposit.${caseId}`],
    );
    return journalId;
  }

  interface ConfirmationOver {
    caseId?: string;
    externalId?: string;
    amount?: number;
    evidence?: { key: string | null; sha: string | null; name: string | null; type: string | null };
    reuseOf?: string | null;
  }

  async function newConfirmation(tx: OrgTx, orgId: string, over: ConfirmationOver = {}): Promise<{ id: string; accountId: string }> {
    const caseId = over.caseId ?? CASE_A;
    const accountId = await newAccount(tx, orgId);
    const journalId = await newJournal(tx, orgId, caseId, newUlid());
    const id = newUlid();
    const ev = over.evidence ?? { key: null, sha: null, name: null, type: null };
    await tx.query(
      `INSERT INTO org.receipt_confirmations
         (id, org_id, case_id, purpose, amount, value_date, payment_account_id, source, external_id, journal_id,
          evidence_key, evidence_sha256, evidence_name, evidence_content_type, evidence_reuse_of)
       VALUES ($1, $2, $3, 'security_deposit', $4, '2026-11-08', $5, 'manual', $6, $7, $8, $9, $10, $11, $12)`,
      [id, orgId, caseId, over.amount ?? 100, accountId, over.externalId ?? newUlid(), journalId, ev.key, ev.sha, ev.name, ev.type, over.reuseOf ?? null],
    );
    return { id, accountId };
  }

  describe('receipt_confirmations', () => {
    it('去重鍵在同一個組織內唯一', async () => {
      await inA((tx) => newConfirmation(tx, orgA, { externalId: 'K1' }));
      await expect(inA((tx) => newConfirmation(tx, orgA, { externalId: 'K1' }))).rejects.toThrow(/duplicate key|unique/i);
    });

    it('別的組織可以用同一個去重鍵', async () => {
      await inA((tx) => newConfirmation(tx, orgA, { externalId: 'K1' }));
      await expect(inOrg(orgB, (tx) => newConfirmation(tx, orgB, { externalId: 'K1', caseId: CASE_B }))).resolves.toBeTruthy();
    });

    it('金額必須大於 0，也不得超過安全整數', async () => {
      await expect(inA((tx) => newConfirmation(tx, orgA, { amount: 0 }))).rejects.toThrow(/check/i);
      await expect(inA((tx) => newConfirmation(tx, orgA, { amount: 9007199254740992 }))).rejects.toThrow(/check/i);
    });

    it('案件必須存在於同一個組織', async () => {
      await expect(inA((tx) => newConfirmation(tx, orgA, { caseId: CASE_B }))).rejects.toThrow(/foreign key|violates/i);
    });

    it('收款帳戶必須屬於同一個組織', async () => {
      const accountB = await inOrg(orgB, (tx) => newAccount(tx, orgB));
      await expect(
        inA(async (tx) => {
          const journalId = await newJournal(tx, orgA, CASE_A, newUlid());
          await tx.query(
            `INSERT INTO org.receipt_confirmations (id, org_id, case_id, purpose, amount, value_date, payment_account_id, source, external_id, journal_id)
             VALUES ($1, $2, $3, 'rent', 100, '2026-11-08', $4, 'manual', 'X', $5)`,
            [newUlid(), orgA, CASE_A, accountB, journalId],
          );
        }),
      ).rejects.toThrow(/foreign key|violates/i);
    });

    it('分錄必須屬於同一個案件，也不能被兩筆入帳確認共用', async () => {
      await expect(
        inA(async (tx) => {
          const accountId = await newAccount(tx, orgA);
          const journalId = await newJournal(tx, orgA, CASE_A2, newUlid());
          await tx.query(
            `INSERT INTO org.receipt_confirmations (id, org_id, case_id, purpose, amount, value_date, payment_account_id, source, external_id, journal_id)
             VALUES ($1, $2, $3, 'rent', 100, '2026-11-08', $4, 'manual', 'X', $5)`,
            [newUlid(), orgA, CASE_A, accountId, journalId],
          );
        }),
      ).rejects.toThrow(/foreign key|violates/i);
      await expect(
        inA(async (tx) => {
          const accountId = await newAccount(tx, orgA);
          const journalId = await newJournal(tx, orgA, CASE_A, newUlid());
          for (const key of ['X1', 'X2']) {
            await tx.query(
              `INSERT INTO org.receipt_confirmations (id, org_id, case_id, purpose, amount, value_date, payment_account_id, source, external_id, journal_id)
               VALUES ($1, $2, $3, 'rent', 100, '2026-11-08', $4, 'manual', $5, $6)`,
              [newUlid(), orgA, CASE_A, accountId, key, journalId],
            );
          }
        }),
      ).rejects.toThrow(/duplicate key|unique/i);
    });

    it('證明檔四個欄位要一起有或一起沒有，key 必須以本組織的前綴開頭', async () => {
      const sha = 'b'.repeat(64);
      const key = (org: string) => `org/${org}/ledger/receipt-evidence/f.pdf`;
      await expect(inA((tx) => newConfirmation(tx, orgA, { evidence: { key: key(orgA), sha: null, name: 'f.pdf', type: 'application/pdf' } }))).rejects.toThrow(/check/i);
      await expect(inA((tx) => newConfirmation(tx, orgA, { evidence: { key: key(orgB), sha, name: 'f.pdf', type: 'application/pdf' } }))).rejects.toThrow(/check/i);
      await expect(inA((tx) => newConfirmation(tx, orgA, { evidence: { key: key(orgA), sha: 'XYZ', name: 'f.pdf', type: 'application/pdf' } }))).rejects.toThrow(/check/i);
      await expect(inA((tx) => newConfirmation(tx, orgA, { evidence: { key: key(orgA), sha, name: 'f.pdf', type: 'application/pdf' } }))).resolves.toBeTruthy();
    });

    it('證明檔重複使用的指向必須是同一個組織的入帳確認，而且本身要有證明檔', async () => {
      const first = await inA((tx) => newConfirmation(tx, orgA));
      await expect(inA((tx) => newConfirmation(tx, orgA, { reuseOf: first.id }))).rejects.toThrow(/check/i);
      const ev = { key: `org/${orgA}/ledger/receipt-evidence/f.pdf`, sha: 'c'.repeat(64), name: 'f.pdf', type: 'application/pdf' };
      await expect(inA((tx) => newConfirmation(tx, orgA, { evidence: ev, reuseOf: newUlid() }))).rejects.toThrow(/foreign key|violates/i);
      await expect(inA((tx) => newConfirmation(tx, orgA, { evidence: ev, reuseOf: first.id }))).resolves.toBeTruthy();
    });

    it('app_rw 不能改也不能刪', async () => {
      const { id } = await inA((tx) => newConfirmation(tx, orgA));
      await expect(inA((tx) => tx.query(`UPDATE org.receipt_confirmations SET amount = 1 WHERE id = $1`, [id]))).rejects.toThrow(/permission denied/);
      await expect(inA((tx) => tx.query(`DELETE FROM org.receipt_confirmations WHERE id = $1`, [id]))).rejects.toThrow(/permission denied/);
      await expect(inA((tx) => tx.query(`TRUNCATE org.receipt_confirmations`))).rejects.toThrow(/permission denied/);
    });
  });

  describe('receipt_allocations', () => {
    async function newPeriod(tx: OrgTx, orgId: string, caseId: string, key = '2026-11'): Promise<string> {
      const id = newUlid();
      await tx.query(
        `INSERT INTO org.receivable_periods (id, org_id, case_id, period_key, period_start, period_end, due_date, amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 30000)`,
        [id, orgId, caseId, key, `${key}-01`, `${key}-28`, `${key}-05`],
      );
      return id;
    }
    const insert = (tx: OrgTx, orgId: string, caseId: string, periodId: string, amount = 100) =>
      tx.query(
        `INSERT INTO org.receipt_allocations (id, org_id, case_id, period_id, source, source_id, amount) VALUES ($1, $2, $3, $4, 'receipt', 'R1', $5) RETURNING id`,
        [newUlid(), orgId, caseId, periodId, amount],
      );

    it('期別必須是同一個案件的期別', async () => {
      const period = await inA((tx) => newPeriod(tx, orgA, CASE_A));
      await expect(inA((tx) => insert(tx, orgA, CASE_A2, period))).rejects.toThrow(/foreign key|violates/i);
    });

    it('金額必須大於 0', async () => {
      const period = await inA((tx) => newPeriod(tx, orgA, CASE_A));
      await expect(inA((tx) => insert(tx, orgA, CASE_A, period, 0))).rejects.toThrow(/check/i);
    });

    it('只有 active 能由 true 改成 false，而且必須同時填失效時間', async () => {
      const period = await inA((tx) => newPeriod(tx, orgA, CASE_A));
      const { id } = (await inA((tx) => insert(tx, orgA, CASE_A, period))).rows[0] as { id: string };
      await expect(inA((tx) => tx.query(`UPDATE org.receipt_allocations SET active = false WHERE id = $1`, [id]))).rejects.toThrow(/check/i);
      await inA((tx) => tx.query(`UPDATE org.receipt_allocations SET active = false, invalidated_at = now() WHERE id = $1`, [id]));
      const row = await inA((tx) => tx.query<{ active: boolean }>(`SELECT active FROM org.receipt_allocations WHERE id = $1`, [id]));
      expect(row.rows[0].active).toBe(false);
    });

    it('金額、期別、來源寫入後不得修改，失效後不得回復，也不得刪除', async () => {
      const period = await inA((tx) => newPeriod(tx, orgA, CASE_A));
      const other = await inA((tx) => newPeriod(tx, orgA, CASE_A, '2026-12'));
      const { id } = (await inA((tx) => insert(tx, orgA, CASE_A, period))).rows[0] as { id: string };
      await expect(inA((tx) => tx.query(`UPDATE org.receipt_allocations SET amount = 1 WHERE id = $1`, [id]))).rejects.toThrow(/不得修改/);
      await expect(inA((tx) => tx.query(`UPDATE org.receipt_allocations SET period_id = $2 WHERE id = $1`, [id, other]))).rejects.toThrow(/不得修改/);
      await expect(inA((tx) => tx.query(`DELETE FROM org.receipt_allocations WHERE id = $1`, [id]))).rejects.toThrow(/不得刪除/);
      await inA((tx) => tx.query(`UPDATE org.receipt_allocations SET active = false, invalidated_at = now() WHERE id = $1`, [id]));
      await expect(
        inA((tx) => tx.query(`UPDATE org.receipt_allocations SET active = true, invalidated_at = NULL WHERE id = $1`, [id])),
      ).rejects.toThrow(/不得回復/);
    });
  });

  describe('deposit_holder_acknowledgments', () => {
    const insertAck = (tx: OrgTx, orgId: string, caseId: string, confirmationId: string, accountId: string, over: { ruleId?: string | null; ruleVersion?: number | null; action?: string } = {}) =>
      tx.query(
        `INSERT INTO org.deposit_holder_acknowledgments (id, org_id, case_id, receipt_confirmation_id, payment_account_id, rule_id, rule_version, action, message_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'deposit_holder.warn.fix_mandate')`,
        [newUlid(), orgId, caseId, confirmationId, accountId, over.ruleId ?? null, over.ruleVersion ?? null, over.action ?? 'warn_fix_mandate'],
      );

    it('一筆入帳確認最多一筆持有人確認紀錄', async () => {
      const c = await inA((tx) => newConfirmation(tx, orgA));
      await inA((tx) => insertAck(tx, orgA, CASE_A, c.id, c.accountId));
      await expect(inA((tx) => insertAck(tx, orgA, CASE_A, c.id, c.accountId))).rejects.toThrow(/duplicate key|unique/i);
    });

    it('規則 ID 與版本要一起有，而且必須是規則表裡存在的版本', async () => {
      const c = await inA((tx) => newConfirmation(tx, orgA));
      await expect(inA((tx) => insertAck(tx, orgA, CASE_A, c.id, c.accountId, { ruleId: 'DHR-03' }))).rejects.toThrow(/check/i);
      await expect(inA((tx) => insertAck(tx, orgA, CASE_A, c.id, c.accountId, { ruleId: 'DHR-03', ruleVersion: 99 }))).rejects.toThrow(/foreign key|violates/i);
      await expect(inA((tx) => insertAck(tx, orgA, CASE_A, c.id, c.accountId, { ruleId: 'DHR-03', ruleVersion: 1 }))).resolves.toBeTruthy();
    });

    it('動作只有 warn 與 warn_fix_mandate，block 與 allow 不留紀錄', async () => {
      const c = await inA((tx) => newConfirmation(tx, orgA));
      for (const action of ['block', 'allow']) {
        await expect(inA((tx) => insertAck(tx, orgA, CASE_A, c.id, c.accountId, { action }))).rejects.toThrow(/check/i);
      }
    });

    it('app_rw 不能改也不能刪', async () => {
      const c = await inA((tx) => newConfirmation(tx, orgA));
      await inA((tx) => insertAck(tx, orgA, CASE_A, c.id, c.accountId));
      await expect(inA((tx) => tx.query(`UPDATE org.deposit_holder_acknowledgments SET action = 'warn'`))).rejects.toThrow(/permission denied/);
      await expect(inA((tx) => tx.query(`DELETE FROM org.deposit_holder_acknowledgments`))).rejects.toThrow(/permission denied/);
    });
  });
});
