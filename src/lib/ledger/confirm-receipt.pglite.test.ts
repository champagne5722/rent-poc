import type { PGliteInterface } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openCaseLedger, type LeaseTerms } from '../case-ledger';
import { deactivatePaymentAccount, registerPaymentAccount } from '../payment-accounts';
import { pgliteDriver } from '../pg/drivers';
import { testCaseId } from '../pg/test-cases';
import { asRole, createTestDb, type TestDb } from '../pg/test-harness';
import { seedOrgMember } from '../pg/test-parties';
import { newUlid } from '../pg/ulid';
import { createWithTx, type OrgTx, type WithTx } from '../pg/with-tx';
import { confirmReceipt } from './confirm-receipt';
import { getDepositCollected, getPrepaidBalance, listAllocations, listPeriodViews, listReceipts } from './receipt-reads';
import type { ReceiptCandidate } from './receipt-types';

// MIL-125：confirmReceipt() 經 withTx 寫進 PGlite。seam 是 confirmReceipt 的回傳值，加上 receipt-reads 的讀取函式。
// 分錄的借貸只在 ADR-0015 明列要驗證的地方用 SQL 讀（科目與金額）。期望值是手算的字面值。
// 期別：2026-11、2026-12、2027-01 各 30000，到期日每月 5 日，押金約定 60000。
// 規則表用 migration 寫入的真實 5 列（DHR-01 到 DHR-05）。

const CASE = testCaseId('CASEA1');
const CASE_B = testCaseId('CASEB1');
const MANDATE_CASE = testCaseId('CASEM1');
const TERMS: LeaseTerms = { deposit: 60000, startDate: '2026-11-01', endDate: '2027-01-31', payDay: 5, rent: 30000 };
const MANDATOR = newUlid();

describe('confirmReceipt', () => {
  let testDb: TestDb;
  let db: PGliteInterface;
  let withTx: WithTx;
  const orgA = newUlid();
  const orgB = newUlid();
  let party = '';
  let lessorAccount = '';
  let managerAccount = '';

  beforeAll(async () => {
    testDb = await createTestDb();
  });
  afterAll(() => testDb.close());

  beforeEach(async () => {
    db = await testDb.fresh();
    withTx = createWithTx(pgliteDriver(db));
    await asRole(db, 'app_owner', async () => {
      await db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, '好管家管理公司', 'practice'), ($2, 'B', 'practice')`, [orgA, orgB]);
    });
    party = await seedOrgMember(withTx, orgA);
    lessorAccount = await newAccount(orgA, 'lessor', '王先生的台新帳戶');
    managerAccount = await newAccount(orgA, 'manager', '好管家的帳戶');
  });

  const inOrg = <T>(orgId: string, fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId }, fn);
  const inA = <T>(fn: (tx: OrgTx) => Promise<T>) => inOrg(orgA, fn);

  async function newAccount(orgId: string, holderKind: 'lessor' | 'owner' | 'manager', name: string): Promise<string> {
    const holder = orgId === orgA ? party : await seedOrgMember(withTx, orgId);
    const result = await inOrg(orgId, (tx) =>
      registerPaymentAccount(tx, { name, holderKind, holderName: '某人', method: 'bank', bankCode: '812', accountLast4: '0123' }, holder),
    );
    if (!result.ok) throw new Error('登錄帳戶失敗');
    return result.id;
  }

  async function newCase(
    id: string,
    over: { orgId?: string; businessType?: string; caseKind?: string; socialHousing?: boolean; open?: boolean; linked?: string } = {},
  ) {
    const orgId = over.orgId ?? orgA;
    await inOrg(orgId, async (tx) => {
      await tx.query(
        `INSERT INTO org.cases (id, org_id, kind, state, business_type, title, social_housing, linked_mandate_case_id)
         VALUES ($1, $2, 'lease', 'active', $3, '板橋區某某路 3 樓', $4, $5)`,
        [id, orgId, over.businessType ?? 'self_managed', over.socialHousing ?? false, over.linked ?? null],
      );
      // 沒傳 caseKind 時由 trigger 依舊欄位補值。包租案件必須明寫（資料上是自管租賃）
      if (over.caseKind) await tx.query(`UPDATE org.cases SET case_kind = $2 WHERE id = $1`, [id, over.caseKind]);
      if (over.open !== false) await openCaseLedger(tx, id, TERMS);
    });
  }

  const candidate = (over: Partial<ReceiptCandidate> = {}): ReceiptCandidate => ({
    source: 'manual',
    externalId: newUlid(),
    caseId: CASE,
    purpose: 'rent',
    amount: 30000,
    valueDate: '2026-11-08',
    paymentAccountId: lessorAccount,
    recordedByPartyId: party,
    onBehalf: false,
    ...over,
  });

  const confirm = (c: ReceiptCandidate) => inA((tx) => confirmReceipt(tx, c));
  async function mustConfirm(c: ReceiptCandidate) {
    const result = await confirm(c);
    if (!result.ok) throw new Error(`入帳失敗：${JSON.stringify(result.failure)}`);
    return result;
  }
  const journalLines = (journalId: string) =>
    inA((tx) =>
      tx.query<{ account: string; debit: string; credit: string }>(
        `SELECT account, debit::text, credit::text FROM org.ledger_entries WHERE journal_id = $1 ORDER BY line_no`,
        [journalId],
      ),
    ).then((r) => r.rows);
  const countOf = (table: string) =>
    inA((tx) => tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`)).then((r) => Number(r.rows[0].n));

  it('控制組：測試連線是 app_rw', async () => {
    expect((await db.query<{ u: string }>('SELECT current_user AS u')).rows[0].u).toBe('app_rw');
  });

  describe('租金', () => {
    beforeEach(async () => {
      await newCase(CASE);
    });

    it('預設配給最舊的未足額期別，期別改為已入帳，分錄是借收款帳戶、貸租金收入', async () => {
      const result = await mustConfirm(candidate({ amount: 30000 }));
      expect(result).toMatchObject({ duplicate: false, prepaid: 0, holderAcknowledgmentId: null });
      expect(result.allocations).toEqual([{ periodId: expect.any(String), periodKey: '2026-11', amount: 30000 }]);
      expect(result.confirmation).toMatchObject({ caseId: CASE, purpose: 'rent', amount: 30000, source: 'manual', hasEvidence: false });

      const periods = await inA((tx) => listPeriodViews(tx, CASE));
      expect(periods.map((p) => [p.periodKey, p.status, p.allocated, p.outstanding])).toEqual([
        ['2026-11', 'paid', 30000, 0],
        ['2026-12', 'unpaid', 0, 30000],
        ['2027-01', 'unpaid', 0, 30000],
      ]);
      expect(await journalLines(result.confirmation.journalId)).toEqual([
        { account: `asset.bank.${lessorAccount}`, debit: '30000', credit: '0' },
        { account: `income.rent.${CASE}`, debit: '0', credit: '30000' },
      ]);
    });

    it('金額不足時期別是部分入帳，顯示差額', async () => {
      await mustConfirm(candidate({ amount: 12000 }));
      const [first] = await inA((tx) => listPeriodViews(tx, CASE));
      expect(first).toMatchObject({ periodKey: '2026-11', status: 'partial', allocated: 12000, outstanding: 18000 });
    });

    it('下一筆先補足部分入帳的期別，再往下一期配', async () => {
      await mustConfirm(candidate({ amount: 12000 }));
      const second = await mustConfirm(candidate({ amount: 25000 }));
      expect(second.allocations.map((a) => [a.periodKey, a.amount])).toEqual([
        ['2026-11', 18000],
        ['2026-12', 7000],
      ]);
      const periods = await inA((tx) => listPeriodViews(tx, CASE));
      expect(periods.map((p) => [p.periodKey, p.status, p.outstanding])).toEqual([
        ['2026-11', 'paid', 0],
        ['2026-12', 'partial', 23000],
        ['2027-01', 'unpaid', 30000],
      ]);
    });

    it('超額部分記為預收租金，分錄多一列貸預收租金', async () => {
      const result = await mustConfirm(candidate({ amount: 100000 }));
      expect(result.prepaid).toBe(10000);
      expect(result.allocations.map((a) => [a.periodKey, a.amount])).toEqual([
        ['2026-11', 30000],
        ['2026-12', 30000],
        ['2027-01', 30000],
      ]);
      expect(await inA((tx) => getPrepaidBalance(tx, CASE))).toBe(10000);
      expect(await journalLines(result.confirmation.journalId)).toEqual([
        { account: `asset.bank.${lessorAccount}`, debit: '100000', credit: '0' },
        { account: `income.rent.${CASE}`, debit: '0', credit: '90000' },
        { account: `liability.prepaid_rent.${CASE}`, debit: '0', credit: '10000' },
      ]);
    });

    it('所有期別都已足額時，整筆都是預收租金', async () => {
      await mustConfirm(candidate({ amount: 90000 }));
      const extra = await mustConfirm(candidate({ amount: 5000 }));
      expect(extra).toMatchObject({ prepaid: 5000, allocations: [] });
      expect(await journalLines(extra.confirmation.journalId)).toEqual([
        { account: `asset.bank.${lessorAccount}`, debit: '5000', credit: '0' },
        { account: `liability.prepaid_rent.${CASE}`, debit: '0', credit: '5000' },
      ]);
    });

    it('已取消的期別不配', async () => {
      await inA((tx) => tx.query(`UPDATE org.receivable_periods SET state = 'cancelled' WHERE case_id = $1 AND period_key = '2026-11'`, [CASE]));
      const result = await mustConfirm(candidate({ amount: 30000 }));
      expect(result.allocations.map((a) => a.periodKey)).toEqual(['2026-12']);
    });

    it('租金入帳不動押金：押金累計與押金餘額維持 0', async () => {
      await mustConfirm(candidate({ amount: 30000 }));
      expect(await inA((tx) => getDepositCollected(tx, CASE))).toBe(0);
    });
  });

  describe('押金', () => {
    beforeEach(async () => {
      await newCase(CASE);
    });

    it('押金記入 liability.deposit，不配置到應收期別，累計已收與約定金額的差額可算', async () => {
      const first = await mustConfirm(candidate({ purpose: 'security_deposit', amount: 40000 }));
      expect(first).toMatchObject({ prepaid: 0, allocations: [] });
      expect(await journalLines(first.confirmation.journalId)).toEqual([
        { account: `asset.bank.${lessorAccount}`, debit: '40000', credit: '0' },
        { account: `liability.deposit.${CASE}`, debit: '0', credit: '40000' },
      ]);
      await mustConfirm(candidate({ purpose: 'security_deposit', amount: 15000 }));
      expect(await inA((tx) => getDepositCollected(tx, CASE))).toBe(55000);
      // 約定 60000，累計 55000，差額 5000：差額由畫面以約定金額減累計算出
      expect((await inA((tx) => listAllocations(tx, CASE))).length).toBe(0);
    });

    it('押金台帳已結清時不得再收押金', async () => {
      await inA((tx) => tx.query(`UPDATE org.deposit_ledgers SET status = 'settled' WHERE case_id = $1`, [CASE]));
      expect(await confirm(candidate({ purpose: 'security_deposit' }))).toEqual({ ok: false, failure: { code: 'deposit_settled' } });
    });
  });

  describe('合約完成前', () => {
    it('沒有押金台帳與應收期別時，租金與押金都不能登錄，什麼都不寫', async () => {
      await newCase(CASE, { open: false });
      expect(await confirm(candidate())).toEqual({ ok: false, failure: { code: 'ledger_not_open' } });
      expect(await confirm(candidate({ purpose: 'security_deposit' }))).toEqual({ ok: false, failure: { code: 'ledger_not_open' } });
      expect(await countOf('org.receipt_confirmations')).toBe(0);
      expect(await countOf('org.ledger_journals')).toBe(0);
    });

    it('案件不存在或屬於別的組織時回 case_not_found', async () => {
      await newCase(CASE_B, { orgId: orgB });
      expect(await confirm(candidate({ caseId: CASE_B }))).toEqual({ ok: false, failure: { code: 'case_not_found' } });
      expect(await confirm(candidate({ caseId: newUlid() }))).toEqual({ ok: false, failure: { code: 'case_not_found' } });
    });
  });

  describe('冪等', () => {
    beforeEach(async () => {
      await newCase(CASE);
    });

    it('同一個去重鍵連送兩次，只入帳一次，第二次回傳原本那筆', async () => {
      const c = candidate({ amount: 30000 });
      const first = await mustConfirm(c);
      const second = await mustConfirm(c);
      expect(second).toMatchObject({ duplicate: true, prepaid: 0 });
      expect(second.confirmation.id).toBe(first.confirmation.id);
      expect(second.allocations).toEqual(first.allocations);
      expect(await countOf('org.receipt_confirmations')).toBe(1);
      expect(await countOf('org.ledger_journals')).toBe(1);
      expect(await countOf('org.receipt_allocations')).toBe(1);
    });

    it('重送超額的入帳，回傳同樣的預收金額', async () => {
      const c = candidate({ amount: 100000 });
      await mustConfirm(c);
      expect(await mustConfirm(c)).toMatchObject({ duplicate: true, prepaid: 10000 });
    });

    it('同一個去重鍵但內容不同時回 idempotency_conflict，不入帳', async () => {
      const c = candidate({ amount: 30000 });
      await mustConfirm(c);
      expect(await confirm({ ...c, amount: 31000 })).toEqual({ ok: false, failure: { code: 'idempotency_conflict' } });
      expect(await countOf('org.receipt_confirmations')).toBe(1);
    });

    it('去重鍵只在同一個來源內唯一：不同來源可以用同樣的字串', async () => {
      const key = newUlid();
      await mustConfirm(candidate({ externalId: key }));
      const other = await mustConfirm(candidate({ source: 'statement_file', externalId: key }));
      expect(other.duplicate).toBe(false);
    });

    it('別的組織用同一個去重鍵不受影響', async () => {
      await newCase(CASE_B, { orgId: orgB });
      const accountB = await newAccount(orgB, 'lessor', 'B 的帳戶');
      const key = newUlid();
      await mustConfirm(candidate({ externalId: key }));
      const inB = await inOrg(orgB, (tx) => confirmReceipt(tx, candidate({ externalId: key, caseId: CASE_B, paymentAccountId: accountB, recordedByPartyId: null })));
      expect(inB).toMatchObject({ ok: true, duplicate: false });
    });
  });

  describe('收款帳戶', () => {
    beforeEach(async () => {
      await newCase(CASE);
    });

    it('別的組織的帳戶、不存在的帳戶、已停用的帳戶，回應都一樣', async () => {
      const accountB = await newAccount(orgB, 'lessor', 'B 的帳戶');
      const stopped = await newAccount(orgA, 'lessor', '停用的帳戶');
      await inA((tx) => deactivatePaymentAccount(tx, stopped));
      for (const paymentAccountId of [accountB, newUlid(), stopped]) {
        expect(await confirm(candidate({ paymentAccountId }))).toEqual({ ok: false, failure: { code: 'account_not_usable' } });
      }
      expect(await countOf('org.receipt_confirmations')).toBe(0);
    });

    it('現金收取帳戶可以入帳，列表標示現金收取', async () => {
      const cash = await inA((tx) => tx.query<{ id: string }>(`SELECT id FROM org.payment_accounts WHERE account_kind = 'cash' AND holder_kind = 'lessor'`));
      await mustConfirm(candidate({ paymentAccountId: cash.rows[0].id }));
      await mustConfirm(candidate());
      const receipts = await inA((tx) => listReceipts(tx, CASE));
      expect(receipts.map((r) => r.isCash)).toEqual([false, true]);
    });
  });

  describe('押金帳戶規則', () => {
    it('自管案件、持有人是出租人：放行，沒有確認紀錄', async () => {
      await newCase(CASE);
      const result = await mustConfirm(candidate({ purpose: 'security_deposit' }));
      expect(result.holderAcknowledgmentId).toBeNull();
      expect(await countOf('org.deposit_holder_acknowledgments')).toBe(0);
    });

    it('轉租案件、持有人是出租人（包租業者）：不警告', async () => {
      await newCase(CASE, { businessType: 'master_lease' });
      const result = await mustConfirm(candidate({ purpose: 'security_deposit' }));
      expect(result.holderAcknowledgmentId).toBeNull();
      expect(result.notices).toEqual([]);
    });

    it('包租案件、持有人是出租人：沿用自管的規則（待法務確認），不警告', async () => {
      await newCase(CASE, { businessType: 'self_managed', caseKind: 'master_lease' });
      const result = await mustConfirm(candidate({ purpose: 'security_deposit' }));
      expect(result.holderAcknowledgmentId).toBeNull();
      expect(result.notices).toEqual([]);
    });

    // MIL-198 改名前後：社宅旗標開、押金收在代管業者的帳戶，只有租賃代管案件被阻擋。
    // 包租案件沿用自管的規則，轉租案件原本就沒有對應的規則列，兩者都放行，與改名前相同。
    it.each([
      ['租賃案件（自管）', { businessType: 'self_managed' }, true],
      ['租賃案件（代管）', { businessType: 'managed' }, false],
      ['包租案件', { businessType: 'self_managed', caseKind: 'master_lease' }, true],
      ['轉租案件', { businessType: 'master_lease' }, true],
    ] as const)('社宅旗標開、押金收在代管業者的帳戶：%s', async (_name, over, allowed) => {
      await newCase(CASE, { ...over, socialHousing: true });
      const result = await confirm(candidate({ purpose: 'security_deposit', paymentAccountId: managerAccount }));
      if (allowed) expect(result).toMatchObject({ ok: true });
      else expect(result).toMatchObject({ ok: false, failure: { code: 'holder_blocked', notice: { ruleId: 'DHR-01' } } });
    });

    it('社宅代管案件、持有人是代管業者：阻擋，回範本依據，什麼都不寫', async () => {
      await newCase(CASE, { businessType: 'managed', socialHousing: true });
      const result = await confirm(candidate({ purpose: 'security_deposit', paymentAccountId: managerAccount, acknowledgeHolderWarning: true }));
      expect(result).toEqual({
        ok: false,
        failure: {
          code: 'holder_blocked',
          notice: { action: 'block', ruleId: 'DHR-01', ruleVersion: 1, messageKey: 'deposit_holder.block.social_housing_manager', holderKind: 'manager' },
        },
      });
      expect(await countOf('org.receipt_confirmations')).toBe(0);
      expect(await countOf('org.ledger_journals')).toBe(0);
    });

    it('社宅代管案件的租金入帳不看持有人，不阻擋', async () => {
      await newCase(CASE, { businessType: 'managed', socialHousing: true });
      expect(await confirm(candidate({ purpose: 'rent', paymentAccountId: managerAccount }))).toMatchObject({ ok: true });
    });

    it('一般代管案件、持有人是代管業者：沒確認就回 holder_ack_required，不寫', async () => {
      await newCase(CASE, { businessType: 'managed' });
      const result = await confirm(candidate({ purpose: 'security_deposit', paymentAccountId: managerAccount }));
      expect(result).toMatchObject({ ok: false, failure: { code: 'holder_ack_required', notice: { action: 'warn_fix_mandate', ruleId: 'DHR-03' } } });
      expect(await countOf('org.receipt_confirmations')).toBe(0);
    });

    it('確認後同交易寫持有人確認紀錄與站內通知，確認者與規則版本都記下', async () => {
      await newCase(CASE, { businessType: 'managed' });
      const result = await mustConfirm(candidate({ purpose: 'security_deposit', paymentAccountId: managerAccount, acknowledgeHolderWarning: true }));
      expect(result.holderAcknowledgmentId).toEqual(expect.any(String));
      const acks = await inA((tx) =>
        tx.query(
          `SELECT receipt_confirmation_id, rule_id, rule_version, action, message_key, acknowledged_by_party_id, payment_account_id
             FROM org.deposit_holder_acknowledgments`,
        ),
      );
      expect(acks.rows).toEqual([
        {
          receipt_confirmation_id: result.confirmation.id,
          rule_id: 'DHR-03',
          rule_version: 1,
          action: 'warn_fix_mandate',
          message_key: 'deposit_holder.warn.fix_mandate',
          acknowledged_by_party_id: party,
          payment_account_id: managerAccount,
        },
      ]);
      const notes = await inA((tx) => tx.query<{ kind: string; link_path: string }>(`SELECT kind, link_path FROM org.notifications`));
      expect(notes.rows).toEqual([{ kind: 'deposit.holder_acknowledged', link_path: `/cases/${CASE}` }]);
      expect(result.notices).toHaveLength(1);
    });

    it('案件有委託人時，另寄 email 給委託人，寄件名義是主辦組織', async () => {
      await inA((tx) => tx.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'mandator@example.com', '王屋主')`, [MANDATOR]));
      await inA((tx) =>
        tx.query(`INSERT INTO org.cases (id, org_id, kind, state, title) VALUES ($1, $2, 'management', 'active', '委託管理')`, [MANDATE_CASE, orgA]),
      );
      await inA((tx) =>
        tx.query(`INSERT INTO org.case_members (id, org_id, case_id, party_id, relation) VALUES ($1, $2, $3, $4, 'mandator')`, [newUlid(), orgA, MANDATE_CASE, MANDATOR]),
      );
      await newCase(CASE, { businessType: 'managed', linked: MANDATE_CASE });
      const result = await mustConfirm(candidate({ purpose: 'security_deposit', paymentAccountId: managerAccount, acknowledgeHolderWarning: true }));
      expect(result.notices.map((n) => n.outboxId)).toEqual([expect.any(String)]);
      const mail = await inA((tx) => tx.query(`SELECT to_email, from_name FROM org.notification_emails`));
      expect(mail.rows).toEqual([{ to_email: 'mandator@example.com', from_name: '好管家管理公司' }]);
    });

    it('重送已確認的押金入帳，不再寫第二筆確認紀錄與通知', async () => {
      await newCase(CASE, { businessType: 'managed' });
      const c = candidate({ purpose: 'security_deposit', paymentAccountId: managerAccount, acknowledgeHolderWarning: true });
      await mustConfirm(c);
      const again = await mustConfirm(c);
      expect(again).toMatchObject({ duplicate: true, notices: [] });
      expect(again.holderAcknowledgmentId).toEqual(expect.any(String));
      expect(await countOf('org.deposit_holder_acknowledgments')).toBe(1);
      expect(await countOf('org.notifications')).toBe(1);
    });
  });

  describe('證明檔', () => {
    const sha = 'a'.repeat(64);
    const evidence = (key = newUlid()) => ({
      objectKey: `org/${orgA}/ledger/receipt-evidence/${key}.pdf`,
      sha256: sha,
      fileName: '匯款單.pdf',
      contentType: 'application/pdf',
    });

    beforeEach(async () => {
      await newCase(CASE);
    });

    it('得不附證明檔', async () => {
      const result = await mustConfirm(candidate());
      expect(result.confirmation).toMatchObject({ hasEvidence: false, evidenceReuseOf: null });
    });

    it('附證明檔時記下；同一份證明檔再用時記錄最早那筆，不阻擋', async () => {
      const first = await mustConfirm(candidate({ evidence: evidence() }));
      expect(first.confirmation).toMatchObject({ hasEvidence: true, evidenceReuseOf: null });
      const second = await mustConfirm(candidate({ evidence: evidence() }));
      expect(second.confirmation).toMatchObject({ hasEvidence: true, evidenceReuseOf: first.confirmation.id });
      const third = await mustConfirm(candidate({ evidence: evidence() }));
      expect(third.confirmation.evidenceReuseOf).toBe(first.confirmation.id);
    });

    it('證明檔位置必須含組織 ID，別的組織的位置被資料庫擋下並整筆回滾', async () => {
      const bad = { ...evidence(), objectKey: `org/${orgB}/ledger/receipt-evidence/x.pdf` };
      await expect(confirm(candidate({ evidence: bad }))).rejects.toThrow();
      expect(await countOf('org.ledger_journals')).toBe(0);
    });
  });

  describe('整筆回滾', () => {
    it('任一步失敗，分錄、確認、配置都不留下', async () => {
      await newCase(CASE);
      // 登錄者不存在於 control.parties：確認紀錄的外鍵在分錄寫入之後才被擋下
      await expect(confirm(candidate({ recordedByPartyId: newUlid() }))).rejects.toThrow();
      expect(await countOf('org.ledger_journals')).toBe(0);
      expect(await countOf('org.receipt_confirmations')).toBe(0);
      expect(await countOf('org.receipt_allocations')).toBe(0);
      const [first] = await inA((tx) => listPeriodViews(tx, CASE));
      expect(first.status).toBe('unpaid');
    });
  });

  describe('輸入檢查', () => {
    beforeEach(async () => {
      await newCase(CASE);
    });

    it.each([
      ['金額為 0', { amount: 0 }],
      ['金額有小數', { amount: 100.5 }],
      ['金額為負', { amount: -1 }],
      ['金額超過安全整數', { amount: Number.MAX_SAFE_INTEGER + 1 }],
      ['入帳日不存在', { valueDate: '2026-02-30' }],
      ['入帳日格式錯誤', { valueDate: '2026/11/08' }],
      ['去重鍵為空', { externalId: '  ' }],
      ['案件 ID 不合法', { caseId: 'not-a-ulid' }],
      ['收款帳戶 ID 不合法', { paymentAccountId: 'x' }],
      ['用途不合法', { purpose: 'deposit' as never }],
      ['來源不合法', { source: 'bank_push' as never }],
    ])('%s：回 invalid_input，什麼都不寫', async (_label, over) => {
      const result = await confirm(candidate(over as Partial<ReceiptCandidate>));
      expect(result).toMatchObject({ ok: false, failure: { code: 'invalid_input' } });
      expect(await countOf('org.receipt_confirmations')).toBe(0);
    });
  });
});
