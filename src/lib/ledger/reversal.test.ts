import { describe, expect, it } from 'vitest';
import { defaultLedgerRegistry } from './events';
import { buildJournal } from './journal';
import { buildReversal, type BuildReversalInput } from './reversal';
import { isReversal, type LedgerErrorCode, type OriginalJournal, type ReversalJournal } from './types';
import { validateJournal } from './validate';

function original(): OriginalJournal {
  const result = buildJournal(defaultLedgerRegistry, {
    journalId: 'J1',
    orgId: 'ORG1',
    caseId: 'CASE1',
    eventType: 'receipt_confirmed',
    eventId: 'EV1',
    postedAt: '2026-11-08T03:00:00.000Z',
    effectiveDate: '2026-11-07',
    payload: { paymentAccountId: 'PAY1', deposit: 60000, rent: 30000, prepaidRent: 500 },
  });
  if (!result.ok) throw new Error('測試前提：原分錄必須建立成功');
  return result.value;
}

const INPUT: BuildReversalInput = {
  journalId: 'J2',
  eventId: 'EV2',
  reason: '承租人匯款帳號登錄錯誤',
  postedAt: '2026-11-09T01:00:00.000Z',
  effectiveDate: '2026-11-09',
};

function codes(journal: OriginalJournal, input: BuildReversalInput): LedgerErrorCode[] {
  const result = buildReversal(journal, input);
  return result.ok ? [] : result.errors.map((e) => e.code);
}

describe('buildReversal：沖銷後借貸互換', () => {
  it('每列的科目不變、借貸互換，順序不變', () => {
    const result = buildReversal(original(), INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lines).toEqual([
      { account: 'asset.bank.PAY1', debit: 0, credit: 90500 },
      { account: 'liability.deposit.CASE1', debit: 60000, credit: 0 },
      { account: 'income.rent.CASE1', debit: 30000, credit: 0 },
      { account: 'liability.prepaid_rent.CASE1', debit: 500, credit: 0 },
    ]);
  });

  it('標頭：沿用原分錄的組織與案件，指向原分錄，帶原因與新的業務事件 ID', () => {
    const result = buildReversal(original(), INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      journalId: 'J2',
      orgId: 'ORG1',
      caseId: 'CASE1',
      eventType: 'reversal',
      eventId: 'EV2',
      postedAt: '2026-11-09T01:00:00.000Z',
      effectiveDate: '2026-11-09',
      reversesJournalId: 'J1',
      reason: '承租人匯款帳號登錄錯誤',
    });
  });

  it('沖銷分錄自己通過 validateJournal，且原分錄不被改動', () => {
    const journal = original();
    const snapshot = JSON.parse(JSON.stringify(journal));
    const result = buildReversal(journal, INPUT);
    expect(result.ok && validateJournal(result.value).ok).toBe(true);
    expect(journal).toEqual(snapshot);
  });

  it('原因前後的空白會被修剪', () => {
    const result = buildReversal(original(), { ...INPUT, reason: '  登錄錯誤  ' });
    expect(result.ok && result.value.reason).toBe('登錄錯誤');
  });
});

describe('buildReversal：必須帶原因', () => {
  it.each([
    ['空字串', ''],
    ['只有空白', '   \n\t'],
    ['不是字串', undefined],
  ])('原因是%s → reason_required', (_name, reason) => {
    expect(codes(original(), { ...INPUT, reason: reason as string })).toEqual(['reason_required']);
  });
});

describe('buildReversal：不得沖銷沖銷分錄', () => {
  function reversalOf(journal: OriginalJournal): ReversalJournal {
    const result = buildReversal(journal, INPUT);
    if (!result.ok) throw new Error('測試前提：沖銷必須建立成功');
    return result.value;
  }

  it('型別上拒絕：ReversalJournal 不能當輸入', () => {
    const reversed = reversalOf(original());
    expect(isReversal(reversed)).toBe(true);
    // @ts-expect-error 沖銷分錄不是 OriginalJournal，編譯期就被擋下
    buildReversal(reversed, { ...INPUT, journalId: 'J3', eventId: 'EV3' });
  });

  it('執行時也拒絕：繞過型別傳入沖銷分錄 → cannot_reverse_reversal', () => {
    const reversed = reversalOf(original()) as unknown as OriginalJournal;
    expect(codes(reversed, { ...INPUT, journalId: 'J3', eventId: 'EV3' })).toEqual(['cannot_reverse_reversal']);
  });

  it('一般分錄不是沖銷分錄', () => {
    expect(isReversal(original())).toBe(false);
  });
});

describe('buildReversal：其他檢查', () => {
  it('原分錄本身不平衡 → original_invalid', () => {
    const broken: OriginalJournal = {
      ...original(),
      lines: [
        { account: 'asset.bank.PAY1', debit: 100, credit: 0 },
        { account: 'income.rent.CASE1', debit: 0, credit: 99 },
      ],
    };
    expect(codes(broken, INPUT)).toEqual(['original_invalid']);
  });

  it('沖銷分錄的 ID 與業務事件 ID 不得沿用原分錄的 → invalid_id', () => {
    expect(codes(original(), { ...INPUT, journalId: 'J1' })).toEqual(['invalid_id']);
    expect(codes(original(), { ...INPUT, eventId: 'EV1' })).toEqual(['invalid_id']);
  });

  it('新分錄的 ID 或日期不合法 → 回報標頭錯誤，並與缺原因一起回報', () => {
    expect(codes(original(), { ...INPUT, journalId: '', effectiveDate: '2026-02-30', reason: '' })).toEqual(
      expect.arrayContaining(['invalid_id', 'invalid_date', 'reason_required']),
    );
  });
});
