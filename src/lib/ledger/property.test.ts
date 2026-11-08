import { describe, expect, it } from 'vitest';
import { naturalBalance } from './accounts';
import { accountTotals } from './balances';
import { defaultLedgerRegistry } from './events';
import { buildJournal } from './journal';
import { buildReversal } from './reversal';
import { isReversal, type Journal, type OriginalJournal } from './types';
import { validateJournal } from './validate';

// 種子亂數（mulberry32）。不新增套件，同一個種子永遠產生同一個序列，失敗時能重現。
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
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
    chance: (p: number) => next() < p,
  };
}

const CASES = ['CASE_A', 'CASE_B', 'CASE_C'];
const ACCOUNTS = ['PAY_1', 'PAY_2', 'PAY_3'];
const NUM_SEEDS = 200;
const EVENTS_PER_SEED = 60;

type Delta = Map<string, number>;

/**
 * 手算模型：每個事件直接寫出各科目「自然方向餘額」的變化量，不經過模板，也不看借貸。
 * 自然方向：資產看借減貸，負債與收入看貸減借。所以入帳時 bank 與 deposit 都是加。
 */
function addDelta(delta: Delta, account: string, amount: number) {
  delta.set(account, (delta.get(account) ?? 0) + amount);
}

interface Simulation {
  journals: Journal[];
  expected: Delta;
  perJournalDelta: Map<string, Delta>;
}

function simulate(seed: number): Simulation {
  const rng = makeRng(seed);
  const journals: Journal[] = [];
  const expected: Delta = new Map();
  const perJournalDelta = new Map<string, Delta>();
  const reversible: OriginalJournal[] = [];
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}${++counter}`;
  const stamp = () => {
    const day = String(rng.int(1, 28)).padStart(2, '0');
    return { postedAt: `2026-11-${day}T08:00:00.000Z`, effectiveDate: `2026-11-${day}` };
  };

  for (let step = 0; step < EVENTS_PER_SEED; step += 1) {
    const caseId = rng.pick(CASES);
    const delta: Delta = new Map();
    const kind = rng.int(0, 5);

    if (kind === 5 && reversible.length > 0) {
      const index = rng.int(0, reversible.length - 1);
      const [target] = reversible.splice(index, 1);
      const result = buildReversal(target, { journalId: nextId('J'), eventId: nextId('E'), reason: '亂數沖銷', ...stamp() });
      expect(result.ok, `seed ${seed} step ${step} 沖銷必須成功`).toBe(true);
      if (!result.ok) continue;
      journals.push(result.value);
      const original = perJournalDelta.get(target.journalId) as Delta;
      for (const [account, amount] of original) addDelta(expected, account, -amount);
      continue;
    }

    let eventType: string;
    let payload: unknown;
    const pay = rng.pick(ACCOUNTS);
    if (kind === 0 || kind === 5) {
      const deposit = rng.chance(0.5) ? rng.int(1, 200000) : 0;
      const rent = rng.chance(0.6) ? rng.int(1, 80000) : 0;
      const prepaidRent = rng.chance(0.3) ? rng.int(1, 5000) : 0;
      if (deposit + rent + prepaidRent === 0) continue;
      eventType = 'receipt_confirmed';
      payload = { paymentAccountId: pay, deposit, rent, prepaidRent };
      addDelta(delta, `asset.bank.${pay}`, deposit + rent + prepaidRent);
      if (deposit) addDelta(delta, `liability.deposit.${caseId}`, deposit);
      if (rent) addDelta(delta, `income.rent.${caseId}`, rent);
      if (prepaidRent) addDelta(delta, `liability.prepaid_rent.${caseId}`, prepaidRent);
    } else if (kind === 1) {
      const amount = rng.int(1, 30000);
      eventType = 'prepaid_applied';
      payload = { amount };
      addDelta(delta, `liability.prepaid_rent.${caseId}`, -amount);
      addDelta(delta, `income.rent.${caseId}`, amount);
    } else if (kind === 2) {
      const amount = rng.int(1, 30000);
      eventType = 'deposit_deducted';
      payload = { amount };
      addDelta(delta, `liability.deposit.${caseId}`, -amount);
      addDelta(delta, `income.deduction.${caseId}`, amount);
    } else if (kind === 3) {
      const amount = rng.int(1, 100000);
      eventType = 'deposit_returned';
      payload = { paymentAccountId: pay, amount };
      addDelta(delta, `liability.deposit.${caseId}`, -amount);
      addDelta(delta, `asset.bank.${pay}`, -amount);
    } else {
      const to = rng.pick(ACCOUNTS.filter((a) => a !== pay));
      const amount = rng.int(1, 50000);
      eventType = 'funds_handed_over';
      payload = { fromPaymentAccountId: pay, toPaymentAccountId: to, amount };
      addDelta(delta, `asset.bank.${to}`, amount);
      addDelta(delta, `asset.bank.${pay}`, -amount);
    }

    const result = buildJournal(defaultLedgerRegistry, {
      journalId: nextId('J'),
      orgId: 'ORG1',
      caseId,
      eventType,
      eventId: nextId('E'),
      payload,
      ...stamp(),
    });
    expect(result.ok, `seed ${seed} step ${step} ${eventType} 必須成功`).toBe(true);
    if (!result.ok) continue;
    journals.push(result.value);
    reversible.push(result.value);
    perJournalDelta.set(result.value.journalId, delta);
    for (const [account, amount] of delta) addDelta(expected, account, amount);
  }
  return { journals, expected, perJournalDelta };
}

describe('性質測試：隨機事件序列', () => {
  it(`每筆分錄通過 validateJournal，各科目餘額等於手算（${NUM_SEEDS} 個種子）`, () => {
    let totalJournals = 0;
    let totalReversals = 0;
    for (let seed = 1; seed <= NUM_SEEDS; seed += 1) {
      const { journals, expected } = simulate(seed);
      totalJournals += journals.length;
      for (const journal of journals) {
        expect(validateJournal(journal).ok, `seed ${seed} 分錄 ${journal.journalId}`).toBe(true);
        if (isReversal(journal)) totalReversals += 1;
      }

      const totals = accountTotals(journals);
      const accounts = new Set([...totals.keys(), ...expected.keys()]);
      for (const account of accounts) {
        const actual = naturalBalance(account, totals.get(account) ?? { debit: 0, credit: 0 });
        expect(actual, `seed ${seed} 科目 ${account}`).toBe(expected.get(account) ?? 0);
      }

      // 全帳借方合計等於貸方合計。
      let debit = 0;
      let credit = 0;
      for (const total of totals.values()) {
        debit += total.debit;
        credit += total.credit;
      }
      expect(debit, `seed ${seed} 全帳借貸合計`).toBe(credit);
    }
    // 防呆：測試真的有跑到沖銷，不是空轉。
    expect(totalJournals).toBeGreaterThan(NUM_SEEDS * 40);
    expect(totalReversals).toBeGreaterThan(NUM_SEEDS * 3);
  });

  it('把所有未沖銷分錄全部沖銷後，所有科目餘額歸零', () => {
    for (let seed = 1000; seed < 1050; seed += 1) {
      const { journals } = simulate(seed);
      const reversedIds = new Set(journals.filter(isReversal).map((j) => j.reversesJournalId));
      const all = [...journals];
      let counter = 0;
      for (const journal of journals) {
        if (isReversal(journal) || reversedIds.has(journal.journalId)) continue;
        const result = buildReversal(journal, {
          journalId: `R${++counter}`,
          eventId: `RE${counter}`,
          reason: '收尾',
          postedAt: '2026-12-01T00:00:00.000Z',
          effectiveDate: '2026-12-01',
        });
        expect(result.ok).toBe(true);
        if (result.ok) all.push(result.value);
      }
      for (const [account, total] of accountTotals(all)) {
        expect(naturalBalance(account, total), `seed ${seed} 科目 ${account}`).toBe(0);
      }
    }
  });
});

describe('性質測試：亂數 payload', () => {
  it('buildJournal 回傳 ok 時，分錄一定通過 validateJournal；金額不合法時不會回 ok', () => {
    const rng = makeRng(424242);
    const weird: unknown[] = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, 2 ** 53, '100', null, undefined, {}, [], true];
    const pickAmount = (): unknown => (rng.chance(0.5) ? rng.int(0, 100000) : rng.pick(weird));
    const types = ['receipt_confirmed', 'prepaid_applied', 'deposit_deducted', 'deposit_returned', 'funds_handed_over'];
    let okCount = 0;
    let rejectedCount = 0;

    for (let i = 0; i < 3000; i += 1) {
      const payload = {
        paymentAccountId: rng.chance(0.9) ? 'PAY_1' : rng.pick(['', 'a.b', 3, null]),
        fromPaymentAccountId: 'PAY_1',
        toPaymentAccountId: rng.chance(0.9) ? 'PAY_2' : 'PAY_1',
        deposit: pickAmount(),
        rent: pickAmount(),
        prepaidRent: pickAmount(),
        amount: pickAmount(),
      };
      const result = buildJournal(defaultLedgerRegistry, {
        journalId: 'J1',
        orgId: 'ORG1',
        caseId: 'CASE1',
        eventType: rng.pick(types),
        eventId: 'E1',
        postedAt: '2026-11-08T00:00:00.000Z',
        effectiveDate: '2026-11-08',
        payload,
      });
      if (result.ok) {
        okCount += 1;
        expect(validateJournal(result.value).ok).toBe(true);
        for (const line of result.value.lines) {
          expect(Number.isSafeInteger(line.debit) && Number.isSafeInteger(line.credit)).toBe(true);
          expect(line.debit >= 0 && line.credit >= 0).toBe(true);
          expect((line.debit > 0) !== (line.credit > 0)).toBe(true);
        }
      } else {
        rejectedCount += 1;
      }
    }
    expect(okCount).toBeGreaterThan(100);
    expect(rejectedCount).toBeGreaterThan(100);
  });
});
