import { describe, expect, it } from 'vitest';
import { formatWaiting, isBacklogged, phaseView, queueTypeLabel, resolutionLabel, stateLabel } from './display';

describe('formatWaiting：審核佇列的等待時間', () => {
  it.each([
    [0, '不到 1 分鐘'],
    [59_999, '不到 1 分鐘'],
    [60_000, '1 分鐘'],
    [59 * 60_000, '59 分鐘'],
    [60 * 60_000, '1 小時'],
    [23 * 3600_000 + 59 * 60_000, '23 小時'],
    [24 * 3600_000, '1 天'],
    [3 * 24 * 3600_000 + 5 * 3600_000, '3 天'],
  ])('%i 毫秒 → %s', (ms, expected) => {
    expect(formatWaiting(ms)).toBe(expected);
  });

  it('負值當作 0', () => {
    expect(formatWaiting(-5)).toBe('不到 1 分鐘');
  });
});

describe('isBacklogged：待審超過 3 日（ADR-0017 決議 12，3 個工作天的近似，假設）', () => {
  it('剛好 3 日不算，超過才算', () => {
    expect(isBacklogged(3 * 24 * 3600_000)).toBe(false);
    expect(isBacklogged(3 * 24 * 3600_000 + 1)).toBe(true);
  });
});

describe('標籤', () => {
  it('驗證狀態：三態各有名稱', () => {
    expect([stateLabel('pending'), stateLabel('verified'), stateLabel('lapsed')]).toEqual(['待驗證', '已驗證', '已失效']);
  });

  it('進度：待補件是 warning，已失效是 error，已驗證是 success；未送件與待核對是中性', () => {
    expect(phaseView('not_submitted')).toEqual({ label: '尚未送件', tone: 'default' });
    expect(phaseView('awaiting_review')).toEqual({ label: '待核對', tone: 'processing' });
    expect(phaseView('needs_resubmission')).toEqual({ label: '待補件', tone: 'warning' });
    expect(phaseView('verified')).toEqual({ label: '已驗證', tone: 'success' });
    expect(phaseView('lapsed')).toEqual({ label: '已失效', tone: 'error' });
  });

  it('佇列項目類型與結案原因', () => {
    expect(queueTypeLabel('license')).toBe('業別核對');
    expect(queueTypeLabel('entity_claim')).toBe('統編認領');
    expect(queueTypeLabel('certificate')).toBe('證書核對');
    expect(resolutionLabel('match')).toBe('相符');
    expect(resolutionLabel('claim_to_claimant')).toBe('改歸認領方');
    expect(resolutionLabel(null)).toBe('');
  });
});
