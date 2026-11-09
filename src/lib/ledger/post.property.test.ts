import type { PGliteInterface } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgliteDriver } from '../pg/drivers';
import { asRole, createTestDb, type TestDb } from '../pg/test-harness';
import { newUlid } from '../pg/ulid';
import { createWithTx, type OrgTx, type WithTx } from '../pg/with-tx';
import { naturalBalance } from './accounts';
import { postJournal, reverseJournal } from './post';

// MIL-117 性質測試：隨機事件序列經 postJournal / reverseJournal 寫進 PGlite 之後，
// 1. 資料庫裡每筆分錄借貸相等，整個組織借方總和等於貸方總和。
// 2. 各科目的自然方向餘額，等於另一套手算模型的結果。手算模型直接寫「這個事件讓哪些科目增減多少」，
//    不經過事件模板，也不看借貸，所以和被測的程式碼不共用邏輯。
// 種子亂數（mulberry32）：同一個種子永遠產生同一個序列，失敗時能重現。

function makeRng(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
    chance: (p: number) => next() < p,
  };
}

const CASES = ['CASE_A', 'CASE_B', 'CASE_C'];
const PAY = ['PAY_1', 'PAY_2', 'PAY_3'];
const NUM_SEEDS = 30;
const EVENTS_PER_SEED = 50;

type Delta = Map<string, number>;
const bump = (delta: Delta, account: string, amount: number) => delta.set(account, (delta.get(account) ?? 0) + amount);

interface Applied {
  journalId: string;
  delta: Delta;
  reversed: boolean;
}

describe('性質測試：隨機事件序列寫進資料庫', () => {
  let testDb: TestDb;
  let db: PGliteInterface;
  let withTx: WithTx;

  beforeAll(async () => {
    testDb = await createTestDb();
    db = await testDb.fresh(); // 一律 app_rw
    withTx = createWithTx(pgliteDriver(db));
  });
  afterAll(() => testDb.close());

  it('控制組：連線是 app_rw', async () => {
    expect((await db.query<{ u: string }>('SELECT current_user AS u')).rows[0].u).toBe('app_rw');
  });

  it.each(Array.from({ length: NUM_SEEDS }, (_, i) => i + 1))('種子 %i：每筆分錄平衡，餘額等於手算', async (seed) => {
    const rng = makeRng(seed * 7919);
    const orgId = newUlid();
    await asRole(db, 'app_owner', async () => {
      await db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, $2, 'owner')`, [orgId, `P${seed}`]);
    });
    const inOrg = <T>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId }, fn);

    const applied: Applied[] = [];
    const expected: Delta = new Map();
    const record = (journalId: string, delta: Delta) => {
      applied.push({ journalId, delta, reversed: false });
      for (const [account, amount] of delta) bump(expected, account, amount);
    };

    for (let i = 0; i < EVENTS_PER_SEED; i++) {
      const caseId = rng.pick(CASES);
      const pay = rng.pick(PAY);
      const eventId = `EV-${seed}-${i}`;
      const effectiveDate = '2026-11-08';
      const kind = rng.pick(['receipt', 'receipt', 'prepaid', 'deduct', 'return', 'handover', 'reverse'] as const);

      if (kind === 'receipt') {
        const deposit = rng.chance(0.5) ? rng.int(1, 100000) : 0;
        const rent = rng.chance(0.6) ? rng.int(1, 100000) : 0;
        const prepaid = rng.chance(0.3) ? rng.int(1, 100000) : 0;
        if (deposit + rent + prepaid === 0) continue;
        const result = await inOrg((tx) =>
          postJournal(tx, { eventType: 'receipt_confirmed', eventId, caseId, effectiveDate, payload: { paymentAccountId: pay, deposit, rent, prepaidRent: prepaid } }),
        );
        expect(result.ok, JSON.stringify(result)).toBe(true);
        if (!result.ok) return;
        const delta: Delta = new Map();
        bump(delta, `asset.bank.${pay}`, deposit + rent + prepaid);
        if (deposit) bump(delta, `liability.deposit.${caseId}`, deposit);
        if (rent) bump(delta, `income.rent.${caseId}`, rent);
        if (prepaid) bump(delta, `liability.prepaid_rent.${caseId}`, prepaid);
        record(result.value.journalId, delta);
      } else if (kind === 'prepaid' || kind === 'deduct' || kind === 'return') {
        const amount = rng.int(1, 50000);
        const eventType = { prepaid: 'prepaid_applied', deduct: 'deposit_deducted', return: 'deposit_returned' }[kind];
        const payload = kind === 'return' ? { paymentAccountId: pay, amount } : { amount };
        const result = await inOrg((tx) => postJournal(tx, { eventType, eventId, caseId, effectiveDate, payload }));
        expect(result.ok, JSON.stringify(result)).toBe(true);
        if (!result.ok) return;
        const delta: Delta = new Map();
        if (kind === 'prepaid') {
          bump(delta, `liability.prepaid_rent.${caseId}`, -amount);
          bump(delta, `income.rent.${caseId}`, amount);
        } else if (kind === 'deduct') {
          bump(delta, `liability.deposit.${caseId}`, -amount);
          bump(delta, `income.deduction.${caseId}`, amount);
        } else {
          bump(delta, `liability.deposit.${caseId}`, -amount);
          bump(delta, `asset.bank.${pay}`, -amount);
        }
        record(result.value.journalId, delta);
      } else if (kind === 'handover') {
        const to = rng.pick(PAY.filter((p) => p !== pay));
        const amount = rng.int(1, 50000);
        const result = await inOrg((tx) =>
          postJournal(tx, { eventType: 'funds_handed_over', eventId, caseId, effectiveDate, payload: { fromPaymentAccountId: pay, toPaymentAccountId: to, amount } }),
        );
        expect(result.ok, JSON.stringify(result)).toBe(true);
        if (!result.ok) return;
        const delta: Delta = new Map();
        bump(delta, `asset.bank.${pay}`, -amount);
        bump(delta, `asset.bank.${to}`, amount);
        record(result.value.journalId, delta);
      } else {
        const candidates = applied.filter((a) => !a.reversed);
        if (candidates.length === 0) continue;
        const target = rng.pick(candidates);
        const result = await inOrg((tx) => reverseJournal(tx, { journalId: target.journalId, eventId, reason: `隨機沖銷 ${i}`, effectiveDate }));
        expect(result.ok, JSON.stringify(result)).toBe(true);
        if (!result.ok) return;
        target.reversed = true;
        for (const [account, amount] of target.delta) bump(expected, account, -amount);
      }
    }
    expect(applied.length, '種子要真的寫進一些分錄').toBeGreaterThan(5);

    // 1. 資料庫裡每筆分錄借貸相等
    const unbalanced = await inOrg((tx) =>
      tx.query(`SELECT journal_id FROM org.ledger_entries GROUP BY journal_id HAVING sum(debit) <> sum(credit)`),
    );
    expect(unbalanced.rows).toEqual([]);
    const totals = await inOrg((tx) => tx.query<{ d: string; c: string }>(`SELECT sum(debit)::text AS d, sum(credit)::text AS c FROM org.ledger_entries`));
    expect(totals.rows[0].d).toBe(totals.rows[0].c);

    // 2. 各科目自然方向餘額等於手算
    const balances = await inOrg((tx) =>
      tx.query<{ account: string; debit: string; credit: string }>(
        `SELECT account, sum(debit)::text AS debit, sum(credit)::text AS credit FROM org.ledger_entries GROUP BY account`,
      ),
    );
    const actual = new Map(balances.rows.map((r) => [r.account, naturalBalance(r.account, { debit: Number(r.debit), credit: Number(r.credit) })]));
    for (const account of new Set([...actual.keys(), ...expected.keys()])) {
      expect(actual.get(account) ?? 0, `科目 ${account}`).toBe(expected.get(account) ?? 0);
    }
  });
});
