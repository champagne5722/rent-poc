import { describe, expect, it } from 'vitest';
import { documentCheckResult, ownershipItemStatus } from './review-status';

const open = { status: 'open', resolution: null, overdue: false, held: false } as const;

describe('審核台出租權源項目的狀態值', () => {
  it('待處理的項目：沒逾時是待核對，逾時是超過 1 個工作日', () => {
    expect(ownershipItemStatus(open)).toBe('pending');
    expect(ownershipItemStatus({ ...open, overdue: true })).toBe('overdue');
  });

  it('停住的項目優先於逾時', () => {
    expect(ownershipItemStatus({ ...open, held: true })).toBe('held');
    expect(ownershipItemStatus({ ...open, held: true, overdue: true })).toBe('held');
  });

  it('已結案的項目看結果，與逾時、停住無關', () => {
    const resolved = { status: 'resolved', overdue: true, held: true } as const;
    expect(ownershipItemStatus({ ...resolved, resolution: 'match' })).toBe('verified');
    expect(ownershipItemStatus({ ...resolved, resolution: 'mismatch' })).toBe('failed');
    expect(ownershipItemStatus({ ...resolved, resolution: 'superseded' })).toBe('superseded');
    expect(ownershipItemStatus({ ...resolved, resolution: null })).toBe('superseded');
  });
});

describe('單項比對結果', () => {
  it('null 是待判定，true 相符，false 不符', () => {
    expect(documentCheckResult(null)).toBe('pending');
    expect(documentCheckResult(true)).toBe('match');
    expect(documentCheckResult(false)).toBe('mismatch');
  });
});
