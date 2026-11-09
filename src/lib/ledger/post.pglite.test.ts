import type { PGliteInterface } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pgliteDriver } from '../pg/drivers';
import { asRole, createTestDb, type TestDb } from '../pg/test-harness';
import { newUlid } from '../pg/ulid';
import { createWithTx, type OrgTx, type WithTx } from '../pg/with-tx';
import { depositAccount, bankAccount, rentIncomeAccount } from './accounts';
import { defaultLedgerRegistry } from './events';
import { postJournal, reverseJournal, type ReverseJournalInput } from './post';
import { asRecord, readAmount } from './payload';
import { defineLedgerEvent, extendLedgerRegistry } from './registry';

// MIL-117：postJournal() 與 reverseJournal() 經 withTx 寫進 PGlite。
// 每個測試 fresh() 取得連線，一律 SET ROLE app_rw，控制組確認 current_user。
// 查表只用在 ADR 明列要驗證的儲存結果（借貸、組織、原因）。其餘行為從回傳值與後續呼叫觀察。

const CASE = 'CASE1';
const receipt = (over: Record<string, unknown> = {}) => ({
  eventType: 'receipt_confirmed',
  eventId: newUlid(),
  caseId: CASE,
  effectiveDate: '2026-11-08',
  payload: { paymentAccountId: 'PA1', deposit: 60000, rent: 30000 },
  ...over,
});

describe('postJournal 與 reverseJournal', () => {
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
  });

  const inOrg = <T>(orgId: string, fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId }, fn);

  const lines = (orgId: string, journalId: string) =>
    inOrg(orgId, (tx) =>
      tx.query<{ account: string; debit: string; credit: string }>(
        `SELECT account, debit::text, credit::text FROM org.ledger_entries WHERE journal_id = $1 ORDER BY line_no`,
        [journalId],
      ),
    ).then((r) => r.rows);

  it('控制組：測試連線是 app_rw', async () => {
    const { rows } = await db.query<{ u: string }>('SELECT current_user AS u');
    expect(rows[0].u).toBe('app_rw');
  });

  describe('postJournal', () => {
    it('依事件模板寫入平衡的分錄，org_id 取自組織脈絡', async () => {
      const result = await inOrg(orgA, (tx) => postJournal(tx, receipt()));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toMatchObject({ orgId: orgA, caseId: CASE, eventType: 'receipt_confirmed', reversesJournalId: null, reason: null });
      expect(await lines(orgA, result.value.journalId)).toEqual([
        { account: bankAccount('PA1'), debit: '90000', credit: '0' },
        { account: depositAccount(CASE), debit: '0', credit: '60000' },
        { account: rentIncomeAccount(CASE), debit: '0', credit: '30000' },
      ]);
    });

    it('登錄時間一律取資料庫的交易時間，呼叫端傳 postedAt 也沒用', async () => {
      const result = await inOrg(orgA, (tx) => postJournal(tx, { ...receipt(), postedAt: '2020-01-01T00:00:00.000Z' } as Parameters<typeof postJournal>[1]));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.postedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
      expect(result.value.postedAt.startsWith('2020')).toBe(false);
      const stored = await inOrg(orgA, (tx) =>
        tx.query<{ year: number }>(`SELECT extract(year FROM posted_at)::int AS year FROM org.ledger_journals WHERE id = $1`, [result.value.journalId]),
      );
      expect(stored.rows[0].year).toBeGreaterThanOrEqual(2026);
    });

    it('同一個業務事件 ID 第二次寫入回傳 duplicate_event，不多寫一筆', async () => {
      const input = receipt({ eventId: 'EVENT-1' });
      const first = await inOrg(orgA, (tx) => postJournal(tx, input));
      const second = await inOrg(orgA, (tx) => postJournal(tx, input));
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.errors.map((e) => e.code)).toEqual(['duplicate_event']);
      const n = await inOrg(orgA, (tx) => tx.query<{ n: number }>('SELECT count(*)::int AS n FROM org.ledger_journals'));
      expect(n.rows[0].n).toBe(1);
    });

    it('別的組織用相同的業務事件 ID 可以寫入', async () => {
      await inOrg(orgA, (tx) => postJournal(tx, receipt({ eventId: 'SAME' })));
      const other = await inOrg(orgB, (tx) => postJournal(tx, receipt({ eventId: 'SAME' })));
      expect(other.ok).toBe(true);
    });

    it('payload 不合法、事件未登錄、案件 ID 不合法：回傳錯誤，什麼都沒寫', async () => {
      const bad = await inOrg(orgA, (tx) => postJournal(tx, receipt({ payload: { paymentAccountId: 'PA1', deposit: -5 } })));
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.errors.map((e) => e.code)).toContain('invalid_payload');
      const unknown = await inOrg(orgA, (tx) => postJournal(tx, receipt({ eventType: 'nobody_defined_this' })));
      expect(unknown.ok).toBe(false);
      if (!unknown.ok) expect(unknown.errors.map((e) => e.code)).toEqual(['unknown_event']);
      const badCase = await inOrg(orgA, (tx) => postJournal(tx, receipt({ caseId: 'has space' })));
      expect(badCase.ok).toBe(false);
      if (!badCase.ok) expect(badCase.errors.map((e) => e.code)).toContain('invalid_id');
      const direct = await inOrg(orgA, (tx) => postJournal(tx, receipt({ eventType: 'reversal', payload: { lines: [] } })));
      expect(direct.ok).toBe(false);
      if (!direct.ok) expect(direct.errors.map((e) => e.code)).toEqual(['event_not_postable']);
      const n = await inOrg(orgA, (tx) => tx.query<{ n: number }>('SELECT count(*)::int AS n FROM org.ledger_journals'));
      expect(n.rows[0].n).toBe(0);
    });

    it('呼叫端的交易失敗時，分錄一起回滾', async () => {
      await expect(
        inOrg(orgA, async (tx) => {
          await postJournal(tx, receipt());
          throw new Error('後續失敗');
        }),
      ).rejects.toThrow('後續失敗');
      const n = await inOrg(orgA, (tx) => tx.query<{ a: number; b: number }>('SELECT (SELECT count(*) FROM org.ledger_journals)::int AS a, (SELECT count(*) FROM org.ledger_entries)::int AS b'));
      expect(n.rows[0]).toEqual({ a: 0, b: 0 });
    });

    it('同一個交易可以寫多筆分錄', async () => {
      await inOrg(orgA, async (tx) => {
        expect((await postJournal(tx, receipt())).ok).toBe(true);
        expect((await postJournal(tx, receipt({ eventType: 'deposit_deducted', payload: { amount: 1000 } }))).ok).toBe(true);
      });
      const n = await inOrg(orgA, (tx) => tx.query<{ n: number }>('SELECT count(*)::int AS n FROM org.ledger_journals'));
      expect(n.rows[0].n).toBe(2);
    });

    it('金額接近安全整數上限時，借貸讀寫都不失真', async () => {
      const big = Number.MAX_SAFE_INTEGER - 10;
      const result = await inOrg(orgA, (tx) => postJournal(tx, receipt({ payload: { paymentAccountId: 'PA1', deposit: big, rent: 0 } })));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect((await lines(orgA, result.value.journalId))[0].debit).toBe(String(big));
      const reversed = await inOrg(orgA, (tx) =>
        reverseJournal(tx, { journalId: result.value.journalId, eventId: newUlid(), reason: '大額測試', effectiveDate: '2026-11-08' }),
      );
      expect(reversed.ok).toBe(true);
    });
  });

  describe('擴充事件：其他線只加事件定義，不改 postJournal', () => {
    // 測試用的擴充事件。形狀是 ADR-0024 的 handover_released：借方兩列（押金、預收），貸方一列（舊收款帳戶）。
    const handoverShape = defineLedgerEvent<{ paymentAccountId: string; deposit: number; prepaidRent: number }>({
      type: 'test_handover_released_shape',
      label: '測試用移交交出側',
      parsePayload(raw) {
        const errors: string[] = [];
        const source = asRecord(raw, errors);
        if (!source) return { ok: false, errors };
        const value = {
          paymentAccountId: typeof source.paymentAccountId === 'string' ? source.paymentAccountId : 'X',
          deposit: readAmount(source, 'deposit', errors),
          prepaidRent: readAmount(source, 'prepaidRent', errors),
        };
        return errors.length === 0 ? { ok: true, value } : { ok: false, errors };
      },
      template: ({ paymentAccountId, deposit, prepaidRent }, { caseId }) => [
        { account: depositAccount(caseId), debit: deposit, credit: 0 },
        { account: `liability.prepaid_rent.${caseId}`, debit: prepaidRent, credit: 0 },
        { account: bankAccount(paymentAccountId), debit: 0, credit: deposit + prepaidRent },
      ],
    });
    const extended = extendLedgerRegistry(defaultLedgerRegistry, [handoverShape]);
    const handover = (over: Record<string, unknown> = {}) =>
      receipt({ eventType: 'test_handover_released_shape', payload: { paymentAccountId: 'OLD', deposit: 60000, prepaidRent: 3000 }, ...over });

    it('預設登錄表不認得新事件；傳入擴充後的登錄表就能寫入，資料庫不必改', async () => {
      const without = await inOrg(orgA, (tx) => postJournal(tx, handover()));
      expect(without.ok).toBe(false);
      if (!without.ok) expect(without.errors.map((e) => e.code)).toEqual(['unknown_event']);

      const result = await inOrg(orgA, (tx) => postJournal(tx, handover(), extended));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(await lines(orgA, result.value.journalId)).toEqual([
        { account: depositAccount(CASE), debit: '60000', credit: '0' },
        { account: `liability.prepaid_rent.${CASE}`, debit: '3000', credit: '0' },
        { account: bankAccount('OLD'), debit: '0', credit: '63000' },
      ]);
    });

    it('新事件的分錄也能沖銷，沖銷不看事件類型', async () => {
      const posted = await inOrg(orgA, (tx) => postJournal(tx, handover(), extended));
      expect(posted.ok).toBe(true);
      if (!posted.ok) return;
      const reversed = await inOrg(orgA, (tx) =>
        reverseJournal(tx, { journalId: posted.value.journalId, eventId: newUlid(), reason: '移交取消', effectiveDate: '2026-11-09' }),
      );
      expect(reversed.ok).toBe(true);
    });
  });

  describe('reverseJournal', () => {
    const post = async (orgId = orgA) => {
      const result = await inOrg(orgId, (tx) => postJournal(tx, receipt()));
      if (!result.ok) throw new Error('測試資料寫入失敗');
      return result.value;
    };
    const reverse = (orgId: string, over: Partial<ReverseJournalInput> & Pick<ReverseJournalInput, 'journalId'>) =>
      inOrg(orgId, (tx) => reverseJournal(tx, { eventId: newUlid(), reason: '登錯', effectiveDate: '2026-11-09', ...over }));

    it('寫入借貸互換的沖銷分錄，帶原因與原分錄 ID', async () => {
      const original = await post();
      const result = await reverse(orgA, { journalId: original.journalId, reason: '  金額登錯  ' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toMatchObject({ eventType: 'reversal', reversesJournalId: original.journalId, reason: '金額登錯', caseId: CASE, orgId: orgA });
      expect(await lines(orgA, result.value.journalId)).toEqual([
        { account: bankAccount('PA1'), debit: '0', credit: '90000' },
        { account: depositAccount(CASE), debit: '60000', credit: '0' },
        { account: rentIncomeAccount(CASE), debit: '30000', credit: '0' },
      ]);
    });

    it('沒有原因被拒絕，什麼都沒寫', async () => {
      const original = await post();
      for (const reason of ['', '   ']) {
        const result = await reverse(orgA, { journalId: original.journalId, reason });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.errors.map((e) => e.code)).toContain('reason_required');
      }
      const n = await inOrg(orgA, (tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM org.ledger_journals WHERE reverses_journal_id IS NOT NULL`));
      expect(n.rows[0].n).toBe(0);
    });

    it('同一筆分錄第二次沖銷回傳 already_reversed', async () => {
      const original = await post();
      expect((await reverse(orgA, { journalId: original.journalId })).ok).toBe(true);
      const second = await reverse(orgA, { journalId: original.journalId });
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.errors.map((e) => e.code)).toEqual(['already_reversed']);
    });

    it('不得沖銷沖銷分錄', async () => {
      const original = await post();
      const reversal = await reverse(orgA, { journalId: original.journalId });
      expect(reversal.ok).toBe(true);
      if (!reversal.ok) return;
      const again = await reverse(orgA, { journalId: reversal.value.journalId });
      expect(again.ok).toBe(false);
      if (!again.ok) expect(again.errors.map((e) => e.code)).toEqual(['cannot_reverse_reversal']);
    });

    it('找不到分錄：不存在的 ID、別的組織的分錄都回傳 journal_not_found', async () => {
      const bJournal = await post(orgB);
      for (const journalId of [newUlid(), bJournal.journalId]) {
        const result = await reverse(orgA, { journalId });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.errors.map((e) => e.code)).toEqual(['journal_not_found']);
      }
    });

    it('呼叫端帶了 caseId 時，必須與原分錄的案件相同', async () => {
      const original = await post();
      const wrong = await reverse(orgA, { journalId: original.journalId, caseId: 'CASE2' });
      expect(wrong.ok).toBe(false);
      if (!wrong.ok) expect(wrong.errors.map((e) => e.code)).toEqual(['case_mismatch']);
      expect((await reverse(orgA, { journalId: original.journalId, caseId: CASE })).ok).toBe(true);
    });

    it('沖銷的業務事件 ID 不得沿用原分錄的，也不得與別的事件重複', async () => {
      const posted = await inOrg(orgA, (tx) => postJournal(tx, receipt({ eventId: 'EV-ORIGINAL' })));
      expect(posted.ok).toBe(true);
      if (!posted.ok) return;
      const same = await reverse(orgA, { journalId: posted.value.journalId, eventId: 'EV-ORIGINAL' });
      expect(same.ok).toBe(false);
      const other = await post();
      const dup = await reverse(orgA, { journalId: other.journalId, eventId: 'REV-1' });
      expect(dup.ok).toBe(true);
      const third = await post();
      const clash = await reverse(orgA, { journalId: third.journalId, eventId: 'REV-1' });
      expect(clash.ok).toBe(false);
      if (!clash.ok) expect(clash.errors.map((e) => e.code)).toEqual(['duplicate_event']);
    });

    it('沖銷後用原本的業務事件 ID 重寫會被擋下（要更正就用新的業務事件 ID）', async () => {
      const original = await inOrg(orgA, (tx) => postJournal(tx, receipt({ eventId: 'EV-FIRST' })));
      if (!original.ok) throw new Error('測試資料寫入失敗');
      expect((await reverse(orgA, { journalId: original.value.journalId })).ok).toBe(true);
      const rewrite = await inOrg(orgA, (tx) => postJournal(tx, receipt({ eventId: 'EV-FIRST' })));
      expect(rewrite.ok).toBe(false);
      if (!rewrite.ok) expect(rewrite.errors.map((e) => e.code)).toEqual(['duplicate_event']);
      expect((await inOrg(orgA, (tx) => postJournal(tx, receipt({ eventId: 'EV-SECOND' })))).ok).toBe(true);
    });
  });
});
