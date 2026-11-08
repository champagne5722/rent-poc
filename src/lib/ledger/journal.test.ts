import { describe, expect, it } from 'vitest';
import { defaultLedgerRegistry } from './events';
import { buildJournal, type BuildJournalInput } from './journal';
import { defineLedgerEvent, createLedgerRegistry } from './registry';
import type { LedgerErrorCode } from './types';

const VALID: BuildJournalInput = {
  journalId: 'J1',
  orgId: 'ORG1',
  caseId: 'CASE1',
  eventType: 'deposit_deducted',
  eventId: 'EV1',
  postedAt: '2026-11-08T03:00:00.000Z',
  effectiveDate: '2026-11-08',
  payload: { amount: 100 },
};

function errorCodes(input: BuildJournalInput): LedgerErrorCode[] {
  const result = buildJournal(defaultLedgerRegistry, input);
  return result.ok ? [] : result.errors.map((e) => e.code);
}

describe('buildJournal 標頭檢查', () => {
  it('合法輸入回傳分錄，時間與 ID 原樣帶入', () => {
    const result = buildJournal(defaultLedgerRegistry, VALID);
    expect(result).toEqual({
      ok: true,
      value: {
        journalId: 'J1',
        orgId: 'ORG1',
        caseId: 'CASE1',
        eventType: 'deposit_deducted',
        eventId: 'EV1',
        postedAt: '2026-11-08T03:00:00.000Z',
        effectiveDate: '2026-11-08',
        reversesJournalId: null,
        reason: null,
        lines: [
          { account: 'liability.deposit.CASE1', debit: 100, credit: 0 },
          { account: 'income.deduction.CASE1', debit: 0, credit: 100 },
        ],
      },
    });
  });

  it.each(['journalId', 'orgId', 'caseId', 'eventId'] as const)('%s 不合法 → invalid_id', (key) => {
    expect(errorCodes({ ...VALID, [key]: '' })).toContain('invalid_id');
    expect(errorCodes({ ...VALID, [key]: 'has space' })).toContain('invalid_id');
  });

  it.each([
    ['postedAt 不是日期', { postedAt: 'yesterday' }],
    ['postedAt 沒有時區', { postedAt: '2026-11-08T03:00:00' }],
    ['effectiveDate 不是日期', { effectiveDate: '11/08/2026' }],
    ['effectiveDate 不存在的日子', { effectiveDate: '2026-02-30' }],
    ['effectiveDate 月份超出', { effectiveDate: '2026-13-01' }],
  ])('%s → invalid_date', (_name, patch) => {
    expect(errorCodes({ ...VALID, ...patch })).toContain('invalid_date');
  });

  it('接受有時區偏移的 postedAt 與閏日', () => {
    expect(errorCodes({ ...VALID, postedAt: '2026-11-08T11:00:00+08:00', effectiveDate: '2028-02-29' })).toEqual([]);
  });
});

describe('buildJournal 事件檢查', () => {
  it('未登錄的事件類型 → unknown_event', () => {
    expect(errorCodes({ ...VALID, eventType: 'no_such_event' })).toEqual(['unknown_event']);
  });

  it('標示為不可直接寫入的事件 → event_not_postable', () => {
    expect(errorCodes({ ...VALID, eventType: 'reversal', payload: { lines: [] } })).toEqual([
      'event_not_postable',
    ]);
  });

  it('模板產生的明細不平衡時，回傳 validateJournal 的錯誤', () => {
    const broken = defineLedgerEvent({
      type: 'broken_event',
      label: '壞掉的事件',
      parsePayload: () => ({ ok: true, value: null }),
      template: () => [
        { account: 'asset.bank.A', debit: 100, credit: 0 },
        { account: 'income.rent.C1', debit: 0, credit: 90 },
      ],
    });
    const registry = createLedgerRegistry([broken]);
    const result = buildJournal(registry, { ...VALID, eventType: 'broken_event', payload: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.code)).toEqual(['unbalanced']);
  });

  it('標頭與 payload 都有錯時，一次回報全部', () => {
    const codes = errorCodes({ ...VALID, orgId: '', payload: { amount: -1 } });
    expect(codes).toEqual(expect.arrayContaining(['invalid_id', 'invalid_payload']));
  });
});
