import { describe, expect, it } from 'vitest';
import {
  OWNERSHIP_EVENTS,
  OWNERSHIP_STATUSES,
  isActiveOwnershipStatus,
  nextOwnershipStatus,
  outcomeOfCheck,
  toPropertyVerificationStatus,
  type OwnershipEvent,
  type OwnershipStatus,
} from './status';
import { FAILED_NOTIFICATION_TITLE, HOLDER_MISMATCH_MESSAGE, KEY_MISMATCH_MESSAGE, VERIFIED_NOTE, failedNotificationBody, mismatchMessages } from './messages';

// 全矩陣：每個狀態乘每個事件。null 代表不合法。
const MATRIX: Record<OwnershipStatus, Record<OwnershipEvent, OwnershipStatus | null>> = {
  pending_verification: { resubmit: null, verify: 'verified', fail: 'failed', lapse: 'lapsed' },
  verified: { resubmit: null, verify: null, fail: null, lapse: 'lapsed' },
  failed: { resubmit: 'pending_verification', verify: null, fail: null, lapse: 'lapsed' },
  lapsed: { resubmit: null, verify: null, fail: null, lapse: null },
};

describe('所有權節點的狀態轉移', () => {
  const cases = OWNERSHIP_STATUSES.flatMap((from) => OWNERSHIP_EVENTS.map((event) => [from, event, MATRIX[from][event]] as const));

  it('矩陣涵蓋每個狀態與事件', () => {
    expect(cases).toHaveLength(OWNERSHIP_STATUSES.length * OWNERSHIP_EVENTS.length);
  });

  it.each(cases)('%s 遇到 %s -> %s', (from, event, expected) => {
    expect(nextOwnershipStatus(from, event)).toBe(expected);
  });

  it('只有待驗證與已驗證是有效狀態', () => {
    expect(OWNERSHIP_STATUSES.filter(isActiveOwnershipStatus)).toEqual(['pending_verification', 'verified']);
  });
});

describe('對外的核對狀態', () => {
  it.each([
    [null, 'pending_verification'],
    ['pending_verification', 'pending_verification'],
    ['verified', 'verified'],
    ['failed', 'failed'],
    ['lapsed', 'pending_verification'],
  ] as const)('節點 %s 對外是 %s', (status, expected) => {
    expect(toPropertyVerificationStatus(status)).toBe(expected);
  });
});

describe('兩項比對到結果與訊息的對應', () => {
  it.each([
    [true, true, 'verified', []],
    [false, true, 'failed', [KEY_MISMATCH_MESSAGE]],
    [true, false, 'failed', [HOLDER_MISMATCH_MESSAGE]],
    [false, false, 'failed', [KEY_MISMATCH_MESSAGE, HOLDER_MISMATCH_MESSAGE]],
  ] as const)('建號 %s、名義人 %s -> %s', (keyMatch, holderMatch, outcome, messages) => {
    expect(outcomeOfCheck({ keyMatch, holderMatch })).toBe(outcome);
    expect(mismatchMessages({ keyMatch, holderMatch })).toEqual(messages);
  });

  it('固定文字照 ADR-0028 與 spec', () => {
    expect(KEY_MISMATCH_MESSAGE).toBe('建號與你的謄本不符，請修正');
    expect(VERIFIED_NOTE).toBe('平台已比對出租權源文件');
  });

  it('訊息與通知不提到任何別人', () => {
    const all = [KEY_MISMATCH_MESSAGE, HOLDER_MISMATCH_MESSAGE, FAILED_NOTIFICATION_TITLE, failedNotificationBody({ keyMatch: false, holderMatch: false })].join('\n');
    expect(all).not.toMatch(/別的組織|其他組織|別人|已有人|重複|撞號|先登錄/);
  });

  it('每句不超過 40 字', () => {
    const sentences = [HOLDER_MISMATCH_MESSAGE, failedNotificationBody({ keyMatch: false, holderMatch: false })].flatMap((t) => t.split(/[。\n]/));
    expect(sentences.filter((s) => s.length > 40)).toEqual([]);
  });
});
