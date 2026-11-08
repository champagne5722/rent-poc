import { describe, expect, it } from 'vitest';
import { CONTRACT_STATUSES, CONTRACT_STATUS_LABELS, isSigningStatus } from './types';

describe('CONTRACT_STATUSES（合約狀態）', () => {
  it('七個狀態，第七態是待執業人員簽', () => {
    expect(CONTRACT_STATUSES).toContain('awaiting_practitioner');
    expect(CONTRACT_STATUSES).toHaveLength(7);
    expect(CONTRACT_STATUS_LABELS.awaiting_practitioner).toBe('待執業人員簽');
  });
});

describe('isSigningStatus（簽署中）', () => {
  it('待乙方簽、待執業人員簽、待甲方簽都算簽署中', () => {
    expect(isSigningStatus('awaiting_tenant')).toBe(true);
    expect(isSigningStatus('awaiting_practitioner')).toBe(true);
    expect(isSigningStatus('awaiting_landlord')).toBe(true);
  });

  it('草稿與已結束的狀態不算簽署中', () => {
    expect(CONTRACT_STATUSES.filter((s) => !isSigningStatus(s))).toEqual([
      'draft',
      'completed',
      'declined',
      'voided',
    ]);
  });
});
