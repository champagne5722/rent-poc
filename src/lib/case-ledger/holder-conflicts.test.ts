import type { PGliteInterface } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerPaymentAccount } from '../payment-accounts';
import { pgliteDriver } from '../pg/drivers';
import { asRole, createTestDb, type TestDb } from '../pg/test-harness';
import { newUlid } from '../pg/ulid';
import { createWithTx, type OrgTx, type WithTx } from '../pg/with-tx';
import { testCaseId } from '../pg/test-cases';
import { listHolderConflicts } from './holder-conflicts';

// MIL-123：社宅旗標與押金持有人的衝突提示。seam 是 listHolderConflicts 的回傳值。
// 規則表用 migration 寫入的真實 5 列（DHR-01 到 DHR-05）。分錄用原始 SQL 寫入：
// 鏡像帳的寫入入口只准 ledger 目錄呼叫（post.guard.test.ts），這裡只需要「有這樣的分錄」。

const CASE = testCaseId('CASEA1');
const PARTY = newUlid();

describe('listHolderConflicts', () => {
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
    await asRole(db, 'app_owner', async () => {
      await db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'A', 'practice')`, [orgA]);
    });
  });

  const inA = <T>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: orgA }, fn);

  async function newCase(over: { businessType?: string; socialHousing?: boolean } = {}): Promise<void> {
    await inA((tx) =>
      tx.query(
        `INSERT INTO org.cases (id, org_id, kind, state, business_type, title, social_housing) VALUES ($1, $2, 'lease', 'active', $3, '測試', $4)`,
        [CASE, orgA, over.businessType ?? 'managed', over.socialHousing ?? true],
      ),
    );
  }

  async function newAccount(holderKind: 'lessor' | 'owner' | 'manager', name: string): Promise<string> {
    const result = await inA((tx) =>
      registerPaymentAccount(tx, { name, holderKind, holderName: '某人', method: 'bank', bankCode: '812', accountLast4: '0123' }, PARTY),
    );
    if (!result.ok) throw new Error('登錄帳戶失敗');
    return result.id;
  }

  let eventNo = 0;
  /** 寫一筆平衡分錄。deposit 正數是收取（借銀行、貸押金），負數是返還或沖銷（借押金、貸銀行）。 */
  async function depositMove(accountId: string, deposit: number, caseId = CASE): Promise<void> {
    await inA(async (tx) => {
      const journalId = newUlid();
      await tx.query(
        `INSERT INTO org.ledger_journals (id, org_id, case_id, business_event_type, business_event_id, effective_date)
         VALUES ($1, $2, $3, 'test_move', $4, '2026-11-08')`,
        [journalId, orgA, caseId, `EVT-${eventNo++}`],
      );
      const amount = Math.abs(deposit);
      const [bankDebit, bankCredit, depositDebit, depositCredit] = deposit > 0 ? [amount, 0, 0, amount] : [0, amount, amount, 0];
      await tx.query(
        `INSERT INTO org.ledger_entries (id, org_id, case_id, journal_id, line_no, account, debit, credit) VALUES
           ($1, $2, $3, $4, 1, $5, $6, $7), ($8, $2, $3, $4, 2, $9, $10, $11)`,
        [newUlid(), orgA, caseId, journalId, `asset.bank.${accountId}`, bankDebit, bankCredit, newUlid(), `liability.deposit.${caseId}`, depositDebit, depositCredit],
      );
    });
  }

  it('控制組：測試連線是 app_rw', async () => {
    expect((await db.query<{ u: string }>('SELECT current_user AS u')).rows[0].u).toBe('app_rw');
  });

  it('社宅代管案件的押金收在代管業者的帳戶：列出衝突，規則是 DHR-01 阻擋', async () => {
    await newCase();
    const manager = await newAccount('manager', '業者帳戶');
    await depositMove(manager, 60000);
    expect(await inA((tx) => listHolderConflicts(tx, CASE))).toEqual([
      {
        paymentAccountId: manager,
        accountName: '業者帳戶',
        holderKind: 'manager',
        collectedAmount: 60000,
        action: 'block',
        ruleId: 'DHR-01',
        ruleVersion: 1,
        messageKey: 'deposit_holder.block.social_housing_manager',
      },
    ]);
  });

  it('押金收在屋主或出租人的帳戶：沒有衝突', async () => {
    await newCase();
    await depositMove(await newAccount('owner', '屋主帳戶'), 60000);
    expect(await inA((tx) => listHolderConflicts(tx, CASE))).toEqual([]);
  });

  it('分兩個帳戶收：只列出有衝突的那個，金額是該帳戶的收取淨額', async () => {
    await newCase();
    const manager = await newAccount('manager', '業者帳戶');
    const owner = await newAccount('owner', '屋主帳戶');
    await depositMove(manager, 40000);
    await depositMove(owner, 20000);
    const conflicts = await inA((tx) => listHolderConflicts(tx, CASE));
    expect(conflicts.map((c) => [c.paymentAccountId, c.collectedAmount])).toEqual([[manager, 40000]]);
  });

  it('一部分已返還：收取淨額扣掉返還，餘額仍大於 0 就仍列出', async () => {
    await newCase();
    const manager = await newAccount('manager', '業者帳戶');
    await depositMove(manager, 60000);
    await depositMove(manager, -20000);
    const conflicts = await inA((tx) => listHolderConflicts(tx, CASE));
    expect(conflicts.map((c) => c.collectedAmount)).toEqual([40000]);
  });

  it('押金全部返還或沖銷、餘額為 0：不列衝突', async () => {
    await newCase();
    const manager = await newAccount('manager', '業者帳戶');
    await depositMove(manager, 60000);
    await depositMove(manager, -60000);
    expect(await inA((tx) => listHolderConflicts(tx, CASE))).toEqual([]);
  });

  it('一般代管案件（非社宅）由代管業者持有：規則是 warn_fix_mandate，不是阻擋', async () => {
    await newCase({ socialHousing: false });
    await depositMove(await newAccount('manager', '業者帳戶'), 60000);
    const conflicts = await inA((tx) => listHolderConflicts(tx, CASE));
    expect(conflicts.map((c) => [c.action, c.ruleId])).toEqual([['warn_fix_mandate', 'DHR-03']]);
  });

  it('自管案件即使旗標為真也不適用（規則只管代管）：沒有衝突', async () => {
    await newCase({ businessType: 'self_managed' });
    await depositMove(await newAccount('manager', '業者帳戶'), 60000);
    expect(await inA((tx) => listHolderConflicts(tx, CASE))).toEqual([]);
  });

  it('沒有分錄、案件不存在：回空陣列', async () => {
    await newCase();
    expect(await inA((tx) => listHolderConflicts(tx, CASE))).toEqual([]);
    expect(await inA((tx) => listHolderConflicts(tx, testCaseId('MXSSNG')))).toEqual([]);
  });
});
