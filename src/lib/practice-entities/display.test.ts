import { describe, expect, it } from 'vitest';
import { claimedKeyText, formatWaiting, isBacklogged, phaseView, queueTypeLabel, resolutionLabel, stateLabel } from './display';

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

describe('撞號項目的顯示（MIL-144）', () => {
  const key = { cityCode: 'A', townCode: '02', sectionCode: '0021', buildingNo: '01234', subNo: '000' };

  it('類型標籤用審核台的詞，畫面不出現「錨點」', () => {
    expect(queueTypeLabel('anchor_collision')).toBe('撞號');
    expect(queueTypeLabel('anchor_collision_limit')).toBe('撞號超限');
  });

  it('宣稱的鍵：縣市、鄉鎮市區、段小段名稱加建號與分號', () => {
    expect(claimedKeyText(key, { cityName: '臺北市', townName: '大安區', sectionName: '龍泉', sectionSubName: '一' })).toBe(
      '臺北市 大安區 龍泉 一　建號 01234-000',
    );
  });

  it('參照表查不到名稱時退回編碼', () => {
    expect(claimedKeyText(key, null)).toBe('A 02 0021　建號 01234-000');
    expect(claimedKeyText(key, { cityName: null, townName: null, sectionName: null, sectionSubName: null })).toBe('A 02 0021　建號 01234-000');
  });
});
