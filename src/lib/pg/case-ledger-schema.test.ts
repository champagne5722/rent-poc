import type { PGliteInterface } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pgliteDriver } from './drivers';
import { seedCases, testCaseId } from './test-cases';
import { asRole, createTestDb, type TestDb } from './test-harness';
import { newUlid } from './ulid';
import { createWithTx, type OrgTx, type WithTx } from './with-tx';

// MIL-123：migration 0055、0056 的資料庫約束。寫入都從 app_rw 發出，用原始 SQL，測的是資料庫自己的防線。
// 讀取政策的逐關係矩陣在 case-rls.test.ts，滲透探測在 rls-penetration.test.ts，這裡不重複。

const CASE_A = testCaseId('CASEA1');
const CASE_A2 = testCaseId('CASEA2');
const CASE_B = testCaseId('CASEB1');

describe('接上案件的表與約束（0055、0056）', () => {
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

  async function postBalancedJournal(tx: OrgTx, orgId: string, caseId: string, eventId: string, amount = 100): Promise<void> {
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

  describe('鏡像帳到 cases 的複合外鍵', () => {
    it('分錄的案件必須存在', async () => {
      await expect(inA((tx) => postBalancedJournal(tx, orgA, testCaseId('MXSSNG'), 'E1'))).rejects.toThrow(/foreign key/i);
      await expect(inA((tx) => postBalancedJournal(tx, orgA, CASE_A, 'E2'))).resolves.toBeUndefined();
    });

    it('分錄不能掛別的組織的案件（外鍵不受 RLS 限制，靠 org_id 擋下）', async () => {
      await expect(inA((tx) => postBalancedJournal(tx, orgA, CASE_B, 'E3'))).rejects.toThrow(/foreign key/i);
    });

    it('外鍵是 NOT VALID：只擋新寫入的列，不回頭檢查既有列（既有分錄不被修改）', async () => {
      const { rows } = await db.query<{ convalidated: boolean }>(
        `SELECT convalidated FROM pg_constraint WHERE conname = 'ledger_journals_case_fk'`,
      );
      expect(rows).toEqual([{ convalidated: false }]);
    });
  });

  describe('社宅旗標與預設收款帳戶（org.cases 的新欄位）', () => {
    it('旗標預設 false，預設帳戶預設空', async () => {
      const { rows } = await inA((tx) =>
        tx.query(`SELECT social_housing, default_rent_account_id, default_deposit_account_id FROM org.cases WHERE id = $1`, [CASE_A]),
      );
      expect(rows).toEqual([{ social_housing: false, default_rent_account_id: null, default_deposit_account_id: null }]);
    });

    async function account(orgId: string): Promise<string> {
      const id = newUlid();
      await inOrg(orgId, (tx) =>
        tx.query(
          `INSERT INTO org.payment_accounts (id, org_id, name, holder_kind, holder_name, account_kind)
           VALUES ($1, $2, '現金', 'other', '某人', 'cash')`,
          [id, orgId],
        ),
      );
      return id;
    }

    it('預設帳戶必須是同一個組織的收款帳戶', async () => {
      const mine = await account(orgA);
      const theirs = await account(orgB);
      await expect(
        inA((tx) => tx.query(`UPDATE org.cases SET default_rent_account_id = $2 WHERE id = $1`, [CASE_A, mine])),
      ).resolves.toBeTruthy();
      await expect(
        inA((tx) => tx.query(`UPDATE org.cases SET default_rent_account_id = $2 WHERE id = $1`, [CASE_A, theirs])),
      ).rejects.toThrow(/foreign key/i);
      await expect(
        inA((tx) => tx.query(`UPDATE org.cases SET default_deposit_account_id = $2 WHERE id = $1`, [CASE_A, theirs])),
      ).rejects.toThrow(/foreign key/i);
    });
  });

  describe('押金台帳', () => {
    const insert = (tx: OrgTx, caseId: string, amount = 60000) =>
      tx.query(`INSERT INTO org.deposit_ledgers (id, org_id, case_id, expected_amount) VALUES ($1, $2, $3, $4)`, [newUlid(), orgA, caseId, amount]);

    it('一個案件只有一份押金台帳', async () => {
      await inA((tx) => insert(tx, CASE_A));
      await expect(inA((tx) => insert(tx, CASE_A))).rejects.toThrow(/unique|duplicate/i);
      await expect(inA((tx) => insert(tx, CASE_A2))).resolves.toBeTruthy();
    });

    it('約定金額不得為負或超過安全整數；案件必須存在', async () => {
      await expect(inA((tx) => insert(tx, CASE_A, -1))).rejects.toThrow(/check constraint/i);
      await expect(inA((tx) => insert(tx, CASE_A, 9007199254740992))).rejects.toThrow(/check constraint/i);
      await expect(inA((tx) => insert(tx, testCaseId('MXSSNG')))).rejects.toThrow(/foreign key/i);
    });

    it('約定金額與案件寫入後不得修改；狀態得改成 settled，但不得重開；不得刪除', async () => {
      await inA((tx) => insert(tx, CASE_A));
      await expect(inA((tx) => tx.query(`UPDATE org.deposit_ledgers SET expected_amount = 1 WHERE case_id = $1`, [CASE_A]))).rejects.toThrow(
        /不得修改/,
      );
      await expect(inA((tx) => tx.query(`UPDATE org.deposit_ledgers SET case_id = $2 WHERE case_id = $1`, [CASE_A, CASE_A2]))).rejects.toThrow(
        /不得修改/,
      );
      await inA((tx) => tx.query(`UPDATE org.deposit_ledgers SET status = 'settled', updated_at = now() WHERE case_id = $1`, [CASE_A]));
      await expect(inA((tx) => tx.query(`UPDATE org.deposit_ledgers SET status = 'open' WHERE case_id = $1`, [CASE_A]))).rejects.toThrow(
        /不得重開/,
      );
      await expect(inA((tx) => tx.query(`DELETE FROM org.deposit_ledgers WHERE case_id = $1`, [CASE_A]))).rejects.toThrow(/不得刪除/);
    });
  });

  describe('應收期別', () => {
    const insert = (tx: OrgTx, over: Partial<Record<string, string | number>> = {}) => {
      const row = {
        caseId: CASE_A,
        key: '2026-11',
        start: '2026-11-01',
        end: '2026-11-30',
        due: '2026-11-05',
        amount: 30000,
        ...over,
      };
      return tx.query(
        `INSERT INTO org.receivable_periods (id, org_id, case_id, period_key, period_start, period_end, due_date, amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [newUlid(), orgA, row.caseId, row.key, row.start, row.end, row.due, row.amount],
      );
    };

    it('一個案件一個月一期', async () => {
      await inA((tx) => insert(tx));
      await expect(inA((tx) => insert(tx))).rejects.toThrow(/unique|duplicate/i);
      await expect(inA((tx) => insert(tx, { key: '2026-12', start: '2026-12-01', end: '2026-12-31', due: '2026-12-05' }))).resolves.toBeTruthy();
      await expect(inA((tx) => insert(tx, { caseId: CASE_A2 }))).resolves.toBeTruthy();
    });

    it.each([
      ['期別鍵格式不對', { key: '2026-13' }],
      ['期別鍵不是日曆月', { key: '2026-1' }],
      ['金額為負', { amount: -1 }],
      ['起日晚於迄日', { start: '2026-12-01' }],
      ['到期日早於起日', { due: '2026-10-31' }],
    ])('%s：被 CHECK 擋下', async (_name, over) => {
      await expect(inA((tx) => insert(tx, over))).rejects.toThrow(/check constraint/i);
    });

    it('只有狀態與逾期時間能改；金額與日期不得改；取消後不得恢復；不得刪除', async () => {
      await inA((tx) => insert(tx));
      const set = (sql: string) => inA((tx) => tx.query(`UPDATE org.receivable_periods SET ${sql} WHERE case_id = $1`, [CASE_A]));
      await expect(set('amount = 1')).rejects.toThrow(/不得修改/);
      await expect(set(`due_date = '2026-11-20'`)).rejects.toThrow(/不得修改/);
      await expect(set(`period_key = '2026-12'`)).rejects.toThrow(/不得修改/);
      await expect(set('overdue_at = now()')).resolves.toBeTruthy();
      await expect(set(`state = 'cancelled'`)).resolves.toBeTruthy();
      await expect(set(`state = 'active'`)).rejects.toThrow(/不得恢復/);
      await expect(inA((tx) => tx.query(`DELETE FROM org.receivable_periods WHERE case_id = $1`, [CASE_A]))).rejects.toThrow(/不得刪除/);
    });
  });

  describe('匯款識別', () => {
    const insert = (tx: OrgTx, caseId: string, kind: string, value: string) =>
      tx.query(`INSERT INTO org.case_remitter_ids (id, org_id, case_id, kind, value) VALUES ($1, $2, $3, $4, $5)`, [newUlid(), orgA, caseId, kind, value]);

    it('帳號末五碼必須是 5 位數字；戶名不得空白、不得超過 60 字', async () => {
      await expect(inA((tx) => insert(tx, CASE_A, 'account_last5', '1234'))).rejects.toThrow(/check constraint/i);
      await expect(inA((tx) => insert(tx, CASE_A, 'account_last5', '1234a'))).rejects.toThrow(/check constraint/i);
      await expect(inA((tx) => insert(tx, CASE_A, 'payer_name', '  '))).rejects.toThrow(/check constraint/i);
      await expect(inA((tx) => insert(tx, CASE_A, 'payer_name', '王'.repeat(61)))).rejects.toThrow(/check constraint/i);
      await expect(inA((tx) => insert(tx, CASE_A, 'phone', '0912345678'))).rejects.toThrow(/check constraint/i);
    });

    it('同一案件不重複登錄同一個識別；不同案件得登錄同一個識別（命中多個案件時進待配對清單）', async () => {
      await inA((tx) => insert(tx, CASE_A, 'payer_name', '王大明'));
      await expect(inA((tx) => insert(tx, CASE_A, 'payer_name', '王大明'))).rejects.toThrow(/unique|duplicate/i);
      await expect(inA((tx) => insert(tx, CASE_A2, 'payer_name', '王大明'))).resolves.toBeTruthy();
    });

    it('得刪除', async () => {
      await inA((tx) => insert(tx, CASE_A, 'account_last5', '12345'));
      const { rows } = await inA((tx) => tx.query(`DELETE FROM org.case_remitter_ids WHERE case_id = $1 RETURNING id`, [CASE_A]));
      expect(rows).toHaveLength(1);
    });
  });

  describe('社宅旗標的修改紀錄', () => {
    const insert = (tx: OrgTx, from: boolean, to: boolean, reason: string) =>
      tx.query(
        `INSERT INTO org.case_social_housing_changes (id, org_id, case_id, from_value, to_value, reason) VALUES ($1, $2, $3, $4, $5, $6)`,
        [newUlid(), orgA, CASE_A, from, to, reason],
      );

    it('必須有原因，旗標必須真的改變，原因不超過 500 字', async () => {
      await expect(inA((tx) => insert(tx, false, true, '  '))).rejects.toThrow(/check constraint/i);
      await expect(inA((tx) => insert(tx, true, true, '無變化'))).rejects.toThrow(/check constraint/i);
      await expect(inA((tx) => insert(tx, false, true, '字'.repeat(501)))).rejects.toThrow(/check constraint/i);
      await expect(inA((tx) => insert(tx, false, true, '標錯了'))).resolves.toBeTruthy();
    });

    it('只增不改：app_rw 沒有 UPDATE 與 DELETE 權限', async () => {
      await inA((tx) => insert(tx, false, true, '標錯了'));
      await expect(inA((tx) => tx.query(`UPDATE org.case_social_housing_changes SET reason = 'x'`))).rejects.toThrow(/permission denied/);
      await expect(inA((tx) => tx.query(`DELETE FROM org.case_social_housing_changes`))).rejects.toThrow(/permission denied/);
    });
  });

  describe('押金餘額 view（org.deposit_balances）', () => {
    it('設了 security_invoker', async () => {
      const { rows } = await db.query<{ reloptions: string[] | null }>(`SELECT reloptions FROM pg_class WHERE oid = 'org.deposit_balances'::regclass`);
      expect(rows[0].reloptions).toContain('security_invoker=true');
    });

    it('只加總押金負債科目，其他科目不算；沒有押金分錄的案件沒有列', async () => {
      await inA((tx) => postBalancedJournal(tx, orgA, CASE_A, 'D1', 60000));
      await inA((tx) => postBalancedJournal(tx, orgA, CASE_A, 'D2', 5000));
      const { rows } = await inA((tx) => tx.query(`SELECT case_id, balance::text AS balance FROM org.deposit_balances ORDER BY case_id`));
      expect(rows).toEqual([{ case_id: CASE_A, balance: '65000' }]);
    });

    it('以呼叫者的身分讀：別的組織看不到；承租人只看到自己案件的餘額', async () => {
      const lessee = newUlid();
      await asRole(db, 'app_owner', () =>
        db.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'lessee@example.com', '承租人')`, [lessee]),
      );
      await inA(async (tx) => {
        await postBalancedJournal(tx, orgA, CASE_A, 'V1', 60000);
        await postBalancedJournal(tx, orgA, CASE_A2, 'V2', 30000);
        await tx.query(`INSERT INTO org.case_members (id, org_id, case_id, party_id, relation) VALUES ($1, $2, $3, $4, 'lessee')`, [
          newUlid(),
          orgA,
          CASE_A,
          lessee,
        ]);
      });
      const asOrgB = await inOrg(orgB, (tx) => tx.query(`SELECT count(*)::int AS n FROM org.deposit_balances`));
      expect(asOrgB.rows).toEqual([{ n: 0 }]);
      const asLessee = await withTx({ kind: 'party', partyId: lessee }, (tx) =>
        tx.query(`SELECT case_id, balance::text AS balance FROM org.deposit_balances`),
      );
      expect(asLessee.rows).toEqual([{ case_id: CASE_A, balance: '60000' }]);
    });
  });
});
