import { describe, expect, it } from 'vitest';
import { parseAccountCode } from '../ledger';
import { buildOwnerReport } from './build';
import { reportToCsv, reportToCsvRows } from './csv';
import {
  ACC_BANK,
  ACC_CASH,
  ACC_MGR,
  OWNER_B,
  emptyInput,
  options,
  receiptJournal,
  receiptRecord,
  reverse,
  unit,
} from './fixtures';
import type { Journal } from '../ledger';
import type { OwnerReportInput, ReportReceipt, ReportUnit } from './types';

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
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
    chance: (p: number) => next() < p,
  };
}

const MONTHS = ['2026-08', '2026-09', '2026-10', '2026-11'];

interface World {
  input: OwnerReportInput;
  otherOwnerJournals: Journal[];
}

function randomWorld(seed: number): World {
  const rng = makeRng(seed);
  const units: ReportUnit[] = [
    unit({ unitId: 'U_A1', caseId: 'C_A1' }),
    unit({ unitId: 'U_A2', caseId: 'C_A2' }),
    unit({ unitId: 'U_B1', caseId: 'C_B1', ownerId: OWNER_B }),
  ];
  const journals: Journal[] = [];
  const receipts: ReportReceipt[] = [];
  const otherOwnerJournals: Journal[] = [];
  const count = rng.int(0, 25);
  for (let i = 0; i < count; i++) {
    const caseId = rng.pick(['C_A1', 'C_A2', 'C_B1']);
    const month = rng.pick(MONTHS);
    const day = String(rng.int(1, 28)).padStart(2, '0');
    const hour = String(rng.int(0, 23)).padStart(2, '0');
    const journal = receiptJournal({
      journalId: `J_${i}`,
      caseId,
      postedAt: `${month}-${day}T${hour}:00:00+08:00`,
      accountId: rng.pick([ACC_BANK, ACC_MGR, ACC_CASH]),
      rent: rng.int(1, 50000),
      deposit: rng.int(0, 50000),
      prepaidRent: rng.int(0, 5000),
    });
    const safe = journal;
    journals.push(safe);
    if (caseId === 'C_B1') otherOwnerJournals.push(safe);
    receipts.push(receiptRecord({ journalId: safe.journalId, caseId, source: rng.pick(['manual', 'statement_file'] as const) }));
    if (rng.chance(0.2)) {
      const reversalMonth = rng.pick(MONTHS);
      journals.push(reverse(safe, { journalId: `R_${i}`, postedAt: `${reversalMonth}-28T12:00:00+08:00` }));
    }
  }
  // 沖銷若比原分錄早登錄就不合理，丟掉
  const byId = new Map(journals.map((j) => [j.journalId, j]));
  const valid = journals.filter((j) => {
    if (j.reversesJournalId === null) return true;
    const original = byId.get(j.reversesJournalId);
    return original !== undefined && Date.parse(original.postedAt) <= Date.parse(j.postedAt);
  });
  return { input: { ...emptyInput(), units, journals: valid, receipts }, otherOwnerJournals };
}

function bankDebit(journal: Journal): number {
  let total = 0;
  for (const line of journal.lines) {
    if (parseAccountCode(line.account)?.name === 'bank') total += line.debit;
  }
  return total;
}

describe('性質：隨機入帳與沖銷', () => {
  const SEEDS = 150;

  it('來源比例合計 = 全部入帳金額，且等於另行手算的本月入帳分錄借方合計', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { input } = randomWorld(seed);
      for (const month of MONTHS) {
        const report = buildOwnerReport(input, month, options());
        const expected = input.journals
          .filter((j) => j.reversesJournalId === null && j.eventType === 'receipt_confirmed')
          .filter((j) => j.caseId !== 'C_B1')
          .filter((j) => new Date(Date.parse(j.postedAt) + 8 * 3600_000).toISOString().slice(0, 7) === month)
          .reduce((sum, j) => sum + bankDebit(j), 0);
        const { totalAmount, items } = report.sourceBreakdown;
        expect(items.reduce((s, i) => s + i.amount, 0), `seed ${seed} ${month}`).toBe(totalAmount);
        expect(totalAmount, `seed ${seed} ${month}`).toBe(expected);
        expect(items.reduce((s, i) => s + i.basisPoints, 0), `seed ${seed} ${month}`).toBe(totalAmount === 0 ? 0 : 10000);
        expect(report.ledgerDetail.filter((r) => r.type !== 'reversal').reduce((s, r) => s + r.amount, 0)).toBe(totalAmount);
      }
    }
  });

  it('加入其他屋主的分錄，屋主 A 的報表不變', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { input } = randomWorld(seed);
      const onlyA: OwnerReportInput = {
        ...input,
        units: input.units.filter((u) => u.ownerId !== OWNER_B),
        journals: input.journals.filter((j) => j.caseId !== 'C_B1'),
        receipts: input.receipts.filter((r) => r.caseId !== 'C_B1'),
      };
      for (const month of MONTHS) {
        expect(buildOwnerReport(input, month, options()), `seed ${seed} ${month}`).toEqual(buildOwnerReport(onlyA, month, options()));
      }
    }
  });

  it('CSV：BOM 開頭、每行九欄、行數 = 展開的資料列加標題列', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { input } = randomWorld(seed);
      const report = buildOwnerReport(input, '2026-10', options());
      const csv = reportToCsv(report);
      expect(csv.charCodeAt(0)).toBe(0xfeff);
      // 沒有儲存格內換行時，行數可直接數
      const lines = csv.split('\r\n');
      expect(lines.pop()).toBe('');
      expect(lines.length).toBe(reportToCsvRows(report).length + 1);
    }
  });
});
