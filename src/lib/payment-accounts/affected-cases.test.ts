import type { PGliteInterface } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pgliteDriver } from '../pg/drivers';
import { asRole, createTestDb, type TestDb } from '../pg/test-harness';
import { newUlid } from '../pg/ulid';
import { createWithTx, type OrgTx, type WithTx } from '../pg/with-tx';
import { listAffectedCases } from './affected-cases';
import { parsePaymentAccountInput } from './input';
import { registerPaymentAccount } from './repository';

// MIL-118、MIL-123：「列出受影響案件」。案件落地後依案件列出：有押金台帳、業務類型與社宅旗標符合、
// 押金曾進入該持有人種類的帳戶。分錄用原始 SQL 寫入：鏡像帳的寫入入口只准 ledger 目錄呼叫（post.guard.test.ts）。
// 規則表用 migration 寫入的 5 列：DHR-01 是代管、社宅、代管業者持有；DHR-02 是代管、非社宅、代管業者持有；
// DHR-04 是包租、非社宅、出租人持有；DHR-05 條件全不限。

describe('listAffectedCases（依案件）', () => {
  let testDb: TestDb;
  let db: PGliteInterface;
  let withTx: WithTx;
  const orgA = newUlid();
  const orgB = newUlid();
  const PARTY = newUlid();

  beforeAll(async () => {
    testDb = await createTestDb();
  });
  afterAll(() => testDb.close());
  beforeEach(async () => {
    db = await testDb.fresh();
    withTx = createWithTx(pgliteDriver(db));
    await asRole(db, 'app_owner', () =>
      db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'A', 'owner'), ($2, 'B', 'owner')`, [orgA, orgB]),
    );
  });
  const inOrg = <T>(orgId: string, fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId }, fn);
  const inA = <T>(fn: (tx: OrgTx) => Promise<T>) => inOrg(orgA, fn);

  /** 建一個案件。hasLedger 為 false 表示合約還沒全員完成，沒有押金台帳。 */
  async function newCase(over: { businessType?: string; socialHousing?: boolean; hasLedger?: boolean; orgId?: string } = {}): Promise<string> {
    const id = newUlid();
    const orgId = over.orgId ?? orgA;
    await inOrg(orgId, async (tx) => {
      await tx.query(
        `INSERT INTO org.cases (id, org_id, kind, state, business_type, title, social_housing) VALUES ($1, $2, 'lease', 'active', $3, '測試', $4)`,
        [id, orgId, over.businessType ?? 'managed', over.socialHousing ?? false],
      );
      if (over.hasLedger !== false) {
        await tx.query(`INSERT INTO org.deposit_ledgers (id, org_id, case_id, expected_amount) VALUES ($1, $2, $3, 60000)`, [newUlid(), orgId, id]);
      }
    });
    return id;
  }

  async function account(holderKind: string, orgId = orgA): Promise<string> {
    const parsed = parsePaymentAccountInput({ name: `${holderKind}帳戶`, holderKind, holderName: '持有人', method: 'bank', bankCode: '812', accountLast4: '0123' });
    if (!parsed.ok) throw new Error(parsed.error);
    const result = await inOrg(orgId, (tx) => registerPaymentAccount(tx, parsed.value, holderKind === 'other' ? null : PARTY));
    if (!result.ok) throw new Error(result.error);
    return result.id;
  }

  let eventNo = 0;
  /** 押金 amount 元進入（正數）或離開（負數）帳戶。 */
  async function depositMove(caseId: string, accountId: string, amount: number, orgId = orgA): Promise<void> {
    await inOrg(orgId, async (tx) => {
      const journalId = newUlid();
      await tx.query(
        `INSERT INTO org.ledger_journals (id, org_id, case_id, business_event_type, business_event_id, effective_date) VALUES ($1, $2, $3, 'test_move', $4, '2026-11-08')`,
        [journalId, orgId, caseId, `EVT-${eventNo++}`],
      );
      const abs = Math.abs(amount);
      const [bankDebit, bankCredit, depositDebit, depositCredit] = amount > 0 ? [abs, 0, 0, abs] : [0, abs, abs, 0];
      await tx.query(
        `INSERT INTO org.ledger_entries (id, org_id, case_id, journal_id, line_no, account, debit, credit) VALUES
           ($1, $2, $3, $4, 1, $5, $6, $7), ($8, $2, $3, $4, 2, $9, $10, $11)`,
        [newUlid(), orgId, caseId, journalId, `asset.bank.${accountId}`, bankDebit, bankCredit, newUlid(), `liability.deposit.${caseId}`, depositDebit, depositCredit],
      );
    });
  }

  const idsOf = (result: Awaited<ReturnType<typeof listAffectedCases>>) => (result.ok ? result.cases.map((c) => c.caseId) : result);

  it('控制組：測試連線是 app_rw', async () => {
    expect((await db.query<{ u: string }>('SELECT current_user AS u')).rows[0].u).toBe('app_rw');
  });

  it('DHR-01：社宅代管案件，押金收在代管業者的帳戶才列出', async () => {
    const manager = await account('manager');
    const owner = await account('owner');
    const hit = await newCase({ socialHousing: true });
    const heldByOwner = await newCase({ socialHousing: true });
    const notSocial = await newCase({ socialHousing: false });
    await depositMove(hit, manager, 60000);
    await depositMove(heldByOwner, owner, 60000);
    await depositMove(notSocial, manager, 60000);
    expect(idsOf(await inA((tx) => listAffectedCases(tx, 'DHR-01', 1)))).toEqual([hit]);
  });

  it('DHR-02：非社宅的代管案件，押金收在代管業者的帳戶', async () => {
    const manager = await account('manager');
    const hit = await newCase({ socialHousing: false });
    const selfManaged = await newCase({ businessType: 'self_managed' });
    await depositMove(hit, manager, 60000);
    await depositMove(selfManaged, manager, 60000);
    expect(idsOf(await inA((tx) => listAffectedCases(tx, 'DHR-02', 1)))).toEqual([hit]);
  });

  it('DHR-04：非社宅的包租案件，押金收在出租人的帳戶', async () => {
    const lessor = await account('lessor');
    const hit = await newCase({ businessType: 'master_lease' });
    await depositMove(hit, lessor, 60000);
    await newCase({ businessType: 'managed' });
    expect(idsOf(await inA((tx) => listAffectedCases(tx, 'DHR-04', 1)))).toEqual([hit]);
  });

  it('萬用列 DHR-05 條件不限：所有有押金台帳的案件都列出，新的在前', async () => {
    const first = await newCase();
    const second = await newCase({ businessType: 'self_managed' });
    expect(idsOf(await inA((tx) => listAffectedCases(tx, 'DHR-05', 1)))).toEqual([second, first]);
  });

  it('押金全部返還後（收取淨額為 0）不列出', async () => {
    const manager = await account('manager');
    const caseId = await newCase();
    await depositMove(caseId, manager, 60000);
    await depositMove(caseId, manager, -60000);
    expect(idsOf(await inA((tx) => listAffectedCases(tx, 'DHR-02', 1)))).toEqual([]);
  });

  it('合約還沒全員完成的案件（沒有押金台帳）不列出', async () => {
    await newCase({ hasLedger: false });
    expect(idsOf(await inA((tx) => listAffectedCases(tx, 'DHR-05', 1)))).toEqual([]);
  });

  it('不列出別的組織的案件', async () => {
    await newCase({ orgId: orgB });
    expect(idsOf(await inA((tx) => listAffectedCases(tx, 'DHR-05', 1)))).toEqual([]);
  });

  it('依版本查：規則有新版本時，舊版本的列仍可查；沒有的版本回 rule_not_found', async () => {
    const manager = await account('manager');
    const caseId = await newCase();
    await depositMove(caseId, manager, 60000);
    await asRole(db, 'app_owner', () =>
      db.query(
        `INSERT INTO control.deposit_holder_rules
           (rule_id, version, business_type, social_housing, holder_kind, mandate_includes_deposit, action, notify_mandator)
         VALUES ('DHR-02', 2, 'managed', false, 'lessor', true, 'block', true)`,
      ),
    );
    expect(idsOf(await inA((tx) => listAffectedCases(tx, 'DHR-02', 1)))).toEqual([caseId]);
    // 版本 2 的持有人種類是 lessor，這個案件的押金收在代管業者的帳戶
    expect(idsOf(await inA((tx) => listAffectedCases(tx, 'DHR-02', 2)))).toEqual([]);
    expect(await inA((tx) => listAffectedCases(tx, 'DHR-02', 3))).toEqual({ ok: false, error: 'rule_not_found' });
    expect(await inA((tx) => listAffectedCases(tx, 'DHR-99', 1))).toEqual({ ok: false, error: 'rule_not_found' });
  });
});
