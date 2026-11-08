import { describe, expect, it } from 'vitest';
import { buildOwnerReport } from './build';
import { ACC_BANK, ACC_CASH, ACC_MGR, emptyInput, options, receiptJournal, receiptRecord, reverse, unit } from './fixtures';
import type { OwnerReportInput } from './types';

const UA1 = unit({ unitId: 'U_A1', caseId: 'C_A1' });

function withReceipts(
  items: Array<{ journalId: string; postedAt: string; effectiveDate?: string; accountId?: string; deposit?: number; rent?: number; prepaidRent?: number; source?: 'manual' | 'statement_file'; note?: string | null }>,
): OwnerReportInput {
  return {
    ...emptyInput(),
    units: [UA1],
    journals: items.map((i) => receiptJournal({ caseId: 'C_A1', ...i })),
    receipts: items.map((i) => receiptRecord({ journalId: i.journalId, caseId: 'C_A1', source: i.source ?? 'manual', note: i.note ?? null })),
  };
}

describe('入帳明細', () => {
  it('一筆入帳含押金、租金、預收時拆成三列，金額合計等於入帳', () => {
    const input = withReceipts([
      { journalId: 'J1', postedAt: '2026-10-06T10:00:00+08:00', deposit: 40000, rent: 20000, prepaidRent: 5000, accountId: ACC_BANK, note: '十月租金加押金' },
    ]);
    const rows = buildOwnerReport(input, '2026-10', options()).ledgerDetail;
    expect(rows.map((r) => [r.type, r.amount])).toEqual([
      ['deposit', 40000],
      ['rent', 20000],
      ['prepaid_rent', 5000],
    ]);
    expect(rows[0]).toMatchObject({
      journalId: 'J1',
      unitId: 'U_A1',
      effectiveDate: '2026-10-06',
      postedDate: '2026-10-06',
      paymentAccountMask: '012-***1234',
      source: 'manual',
      note: '十月租金加押金',
      reversed: false,
      reversesJournalId: null,
    });
  });

  it('報表月份依 posted_at 的台灣日期，銀行日只是顯示欄位', () => {
    const input = withReceipts([
      // UTC 9 月 30 日 17:00 = 台灣 10 月 1 日 01:00
      { journalId: 'J_EDGE', postedAt: '2026-09-30T17:00:00Z', rent: 1000 },
      // 銀行日是 9 月底，但 10 月才登錄
      { journalId: 'J_LATE', postedAt: '2026-10-02T10:00:00+08:00', rent: 2000, effectiveDate: '2026-09-29' },
      // 台灣 9 月 30 日 23:59，仍屬 9 月
      { journalId: 'J_SEP', postedAt: '2026-09-30T15:59:00Z', rent: 3000 },
    ]);
    const oct = buildOwnerReport(input, '2026-10', options()).ledgerDetail;
    expect(oct.map((r) => r.journalId)).toEqual(['J_EDGE', 'J_LATE']);
    expect(oct[1]).toMatchObject({ effectiveDate: '2026-09-29', postedDate: '2026-10-02' });
    expect(buildOwnerReport(input, '2026-09', options()).ledgerDetail.map((r) => r.journalId)).toEqual(['J_SEP']);
  });

  it('上月入帳在本月被沖銷：本月出現負數沖銷列，上月入帳不再出現在本月', () => {
    const sep = receiptJournal({ journalId: 'J_SEP', caseId: 'C_A1', postedAt: '2026-09-28T10:00:00+08:00', rent: 20000 });
    const input: OwnerReportInput = {
      ...emptyInput(),
      units: [UA1],
      journals: [sep, reverse(sep, { journalId: 'J_SEP_R', postedAt: '2026-10-03T10:00:00+08:00', reason: '金額登錄錯誤' })],
      receipts: [receiptRecord({ journalId: 'J_SEP', caseId: 'C_A1', source: 'statement_file', note: '對帳檔第 3 列' })],
    };
    const oct = buildOwnerReport(input, '2026-10', options());
    expect(oct.ledgerDetail).toEqual([
      {
        journalId: 'J_SEP_R',
        unitId: 'U_A1',
        address: 'U_A1 路 1 號',
        type: 'reversal',
        effectiveDate: '2026-10-03',
        postedDate: '2026-10-03',
        amount: -20000,
        paymentAccountMask: '012-***1234',
        source: 'statement_file',
        note: '沖銷分錄 J_SEP（入帳確認），原因：金額登錄錯誤',
        reversed: false,
        reversesJournalId: 'J_SEP',
      },
    ]);
    // 本月來源比例只算本月入帳，沖銷不扣
    expect(oct.sourceBreakdown.totalAmount).toBe(0);

    // 上月報表在沖銷前後完全相同
    const before: OwnerReportInput = { ...input, journals: [sep] };
    expect(buildOwnerReport(input, '2026-09', options())).toEqual(buildOwnerReport(before, '2026-09', options()));
    expect(buildOwnerReport(input, '2026-09', options()).ledgerDetail[0].reversed).toBe(false);
  });

  it('同月內被沖銷的入帳標示已被沖銷，沖銷列也在', () => {
    const j = receiptJournal({ journalId: 'J1', caseId: 'C_A1', postedAt: '2026-10-04T10:00:00+08:00', rent: 20000 });
    const input: OwnerReportInput = {
      ...emptyInput(),
      units: [UA1],
      journals: [j, reverse(j, { journalId: 'J1_R', postedAt: '2026-10-05T10:00:00+08:00' })],
      receipts: [receiptRecord({ journalId: 'J1', caseId: 'C_A1' })],
    };
    const rows = buildOwnerReport(input, '2026-10', options()).ledgerDetail;
    expect(rows.map((r) => [r.journalId, r.type, r.amount, r.reversed])).toEqual([
      ['J1', 'rent', 20000, true],
      ['J1_R', 'reversal', -20000, false],
    ]);
  });

  it('入帳明細依登錄時間排序，同時間依分錄 ID', () => {
    const input = withReceipts([
      { journalId: 'J_B', postedAt: '2026-10-05T10:00:00+08:00', rent: 1 },
      { journalId: 'J_A', postedAt: '2026-10-05T10:00:00+08:00', rent: 1 },
      { journalId: 'J_0', postedAt: '2026-10-01T10:00:00+08:00', rent: 1 },
    ]);
    expect(buildOwnerReport(input, '2026-10', options()).ledgerDetail.map((r) => r.journalId)).toEqual(['J_0', 'J_A', 'J_B']);
  });

  it('入帳分錄沒有入帳確認、或收款帳戶不在輸入內時丟 RangeError', () => {
    const input = withReceipts([{ journalId: 'J1', postedAt: '2026-10-05T10:00:00+08:00', rent: 1 }]);
    expect(() => buildOwnerReport({ ...input, receipts: [] }, '2026-10', options())).toThrow(RangeError);
    expect(() => buildOwnerReport({ ...input, paymentAccounts: [] }, '2026-10', options())).toThrow(RangeError);
  });
});

describe('來源比例', () => {
  const input = withReceipts([
    { journalId: 'J1', postedAt: '2026-10-02T10:00:00+08:00', rent: 10000, source: 'manual' },
    { journalId: 'J2', postedAt: '2026-10-03T10:00:00+08:00', rent: 12000, deposit: 8000, source: 'statement_file', accountId: ACC_MGR },
    // 現金收取帳戶：登錄方式是手動，報表一律算現金收取
    { journalId: 'J3', postedAt: '2026-10-04T10:00:00+08:00', rent: 5000, source: 'manual', accountId: ACC_CASH },
  ]);

  it('依金額列出對帳檔、手動、現金收取，現金帳戶的入帳算現金收取', () => {
    const { sourceBreakdown } = buildOwnerReport(input, '2026-10', options());
    expect(sourceBreakdown.totalAmount).toBe(35000);
    expect(sourceBreakdown.items.map((i) => [i.source, i.amount])).toEqual([
      ['manual', 10000],
      ['statement_file', 20000],
      ['cash', 5000],
    ]);
  });

  it('來源金額合計等於全部入帳金額，也等於入帳明細的入帳列合計', () => {
    const report = buildOwnerReport(input, '2026-10', options());
    const bySource = report.sourceBreakdown.items.reduce((s, i) => s + i.amount, 0);
    const detail = report.ledgerDetail.filter((r) => r.type !== 'reversal').reduce((s, r) => s + r.amount, 0);
    expect(bySource).toBe(report.sourceBreakdown.totalAmount);
    expect(detail).toBe(report.sourceBreakdown.totalAmount);
    expect(bySource).toBe(10000 + 20000 + 5000);
  });

  it('比例用最大餘數法湊成 100.00%：2857 + 5714 + 1429', () => {
    const { items } = buildOwnerReport(input, '2026-10', options()).sourceBreakdown;
    expect(items.map((i) => i.basisPoints)).toEqual([2857, 5714, 1429]);
    expect(items.reduce((s, i) => s + i.basisPoints, 0)).toBe(10000);
  });

  it('本月沒有入帳時三項都是 0', () => {
    const { sourceBreakdown } = buildOwnerReport({ ...emptyInput(), units: [UA1] }, '2026-10', options());
    expect(sourceBreakdown).toEqual({
      totalAmount: 0,
      items: [
        { source: 'manual', amount: 0, basisPoints: 0 },
        { source: 'statement_file', amount: 0, basisPoints: 0 },
        { source: 'cash', amount: 0, basisPoints: 0 },
      ],
    });
  });

  it('只有一種來源時佔 100%', () => {
    const only = withReceipts([{ journalId: 'J1', postedAt: '2026-10-02T10:00:00+08:00', rent: 7, source: 'statement_file' }]);
    expect(buildOwnerReport(only, '2026-10', options()).sourceBreakdown.items.map((i) => i.basisPoints)).toEqual([0, 10000, 0]);
  });
});
