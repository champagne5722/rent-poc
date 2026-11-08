import { describe, expect, it } from 'vitest';
import { buildOwnerReport } from './build';
import {
  ACC_MGR,
  asOriginal,
  deductionJournal,
  emptyInput,
  options,
  receiptJournal,
  receiptRecord,
  returnJournal,
  reverse,
  unit,
} from './fixtures';
import type { OwnerReportInput } from './types';

const UA1 = unit({ unitId: 'U_A1', caseId: 'C_A1', agreedHandoverDays: 3 });

function depositFixture(): OwnerReportInput {
  return {
    ...emptyInput(),
    units: [UA1],
    depositLedgers: [{ caseId: 'C_A1', expectedAmount: 40000, paymentAccountId: ACC_MGR }],
    journals: [
      receiptJournal({ journalId: 'J_D1', caseId: 'C_A1', postedAt: '2026-09-03T10:00:00+08:00', deposit: 40000, accountId: ACC_MGR }),
      deductionJournal({ journalId: 'J_D2', caseId: 'C_A1', postedAt: '2026-10-15T10:00:00+08:00', amount: 3000 }),
      returnJournal({ journalId: 'J_D3', caseId: 'C_A1', postedAt: '2026-10-20T10:00:00+08:00', amount: 5000 }),
    ],
    receipts: [receiptRecord({ journalId: 'J_D1', caseId: 'C_A1' })],
    deductions: [{ deductionId: 'DED_1', caseId: 'C_A1', journalId: 'J_D2', reason: '牆面修補', disputed: true }],
    holderAcknowledgments: [
      { caseId: 'C_A1', confirmedBy: '陳經理', confirmedAt: '2026-09-03T09:00:00+08:00', ruleId: 'DHR-02', ruleVersion: 1 },
    ],
  };
}

describe('押金區段', () => {
  it('約定、已收、本月扣抵、本月返還、餘額', () => {
    const row = buildOwnerReport(depositFixture(), '2026-10', options()).deposit[0];
    expect(row).toMatchObject({
      unitId: 'U_A1',
      expected: 40000,
      received: 40000,
      deducted: 3000,
      returned: 5000,
      balance: 32000,
    });
  });

  it('只算本月：上月的收取不算本月扣抵，下月的扣抵不計入', () => {
    const input = depositFixture();
    input.journals = [
      ...input.journals,
      deductionJournal({ journalId: 'J_D4', caseId: 'C_A1', postedAt: '2026-11-02T10:00:00+08:00', amount: 1000 }),
    ];
    const sep = buildOwnerReport(input, '2026-09', options()).deposit[0];
    expect(sep).toMatchObject({ received: 40000, deducted: 0, returned: 0, balance: 40000 });
    const oct = buildOwnerReport(input, '2026-10', options()).deposit[0];
    expect(oct.balance).toBe(32000);
  });

  it('收款帳戶持有人、確認者與約定日數', () => {
    const row = buildOwnerReport(depositFixture(), '2026-10', options()).deposit[0];
    expect(row.holderKind).toBe('manager');
    expect(row.holderMaskedId).toBe('808-***5678');
    expect(row.remark).toBe('陳經理 於 2026-09-03 確認，約定 3 日內交付');
  });

  it('持有人不是代管業者時不寫約定日數，也沒有確認者時備註為 null', () => {
    const input = depositFixture();
    input.depositLedgers = [{ caseId: 'C_A1', expectedAmount: 40000, paymentAccountId: 'PAY_BANK' }];
    input.holderAcknowledgments = [];
    const row = buildOwnerReport(input, '2026-10', options()).deposit[0];
    expect(row.holderKind).toBe('lessor');
    expect(row.remark).toBeNull();
  });

  it('扣抵明細帶原因與異議，金額以分錄為準', () => {
    const row = buildOwnerReport(depositFixture(), '2026-10', options()).deposit[0];
    expect(row.deductions).toEqual([
      { deductionId: 'DED_1', amount: 3000, reason: '牆面修補', disputed: true, reversed: false },
    ]);
  });

  it('本月沖銷上月的扣抵：本月扣抵淨額為負，餘額回補，上月報表不變', () => {
    const base = depositFixture();
    const sepDeduction = deductionJournal({ journalId: 'J_D5', caseId: 'C_A1', postedAt: '2026-09-20T10:00:00+08:00', amount: 2000 });
    const withReversal: OwnerReportInput = {
      ...base,
      journals: [...base.journals, sepDeduction, reverse(sepDeduction, { journalId: 'J_D5_R', postedAt: '2026-10-02T10:00:00+08:00' })],
    };
    const withoutReversal: OwnerReportInput = { ...base, journals: [...base.journals, sepDeduction] };

    const oct = buildOwnerReport(withReversal, '2026-10', options()).deposit[0];
    expect(oct.deducted).toBe(3000 - 2000);
    expect(oct.balance).toBe(40000 - 3000 - 5000);
    // 9 月報表在沖銷前後完全相同
    expect(buildOwnerReport(withReversal, '2026-09', options())).toEqual(buildOwnerReport(withoutReversal, '2026-09', options()));
    expect(buildOwnerReport(withReversal, '2026-09', options()).deposit[0].balance).toBe(38000);
  });

  it('被沖銷的入帳不算已收，被沖銷的扣抵標示已沖銷', () => {
    const input = depositFixture();
    const received = asOriginal(input.journals[0]);
    const deduction = asOriginal(input.journals[1]);
    input.journals = [
      ...input.journals,
      reverse(deduction, { journalId: 'J_D2_R', postedAt: '2026-10-25T10:00:00+08:00' }),
      reverse(received, { journalId: 'J_D1_R', postedAt: '2026-10-26T10:00:00+08:00' }),
    ];
    const row = buildOwnerReport(input, '2026-10', options()).deposit[0];
    expect(row.received).toBe(0);
    expect(row.deducted).toBe(0);
    expect(row.balance).toBe(-5000); // 返還 5000 沒有被沖銷，餘額為負表示資料有問題，報表照實呈現
    expect(row.deductions[0].reversed).toBe(true);
  });

  it('沒有台帳也沒有押金分錄的單位不列', () => {
    const input = { ...emptyInput(), units: [UA1] };
    expect(buildOwnerReport(input, '2026-10', options()).deposit).toEqual([]);
  });

  it('摘要的押金餘額是各單位月底餘額合計', () => {
    const input = depositFixture();
    input.units = [UA1, unit({ unitId: 'U_A2', caseId: 'C_A2' })];
    input.journals = [
      ...input.journals,
      receiptJournal({ journalId: 'J_D9', caseId: 'C_A2', postedAt: '2026-10-02T10:00:00+08:00', deposit: 10000 }),
    ];
    input.receipts = [{ receiptId: 'R9', caseId: 'C_A2', journalId: 'J_D9', source: 'manual', note: null }];
    expect(buildOwnerReport(input, '2026-10', options()).summary.depositBalance).toBe(32000 + 10000);
  });

  it('扣抵指向不存在的分錄丟 RangeError', () => {
    const input = depositFixture();
    input.deductions = [{ deductionId: 'DED_X', caseId: 'C_A1', journalId: 'J_NONE', reason: 'x', disputed: false }];
    expect(() => buildOwnerReport(input, '2026-10', options())).toThrow(RangeError);
  });

  it('沖銷分錄的原分錄不在輸入內丟 RangeError，不默默算錯', () => {
    const input = depositFixture();
    const orphan = reverse(asOriginal(input.journals[1]), { journalId: 'J_ORPHAN', postedAt: '2026-10-25T10:00:00+08:00' });
    input.journals = [input.journals[0], orphan];
    expect(() => buildOwnerReport(input, '2026-10', options())).toThrow(RangeError);
  });
});
