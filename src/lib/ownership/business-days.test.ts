import { describe, expect, it } from 'vitest';
import { businessMsBetween, isReviewOverdue } from './business-days';

const HOUR = 3_600_000;
// 臺北時間轉 Date。2026-11-09 是星期一
const taipei = (iso: string) => new Date(`${iso}+08:00`);

describe('工作日的等待時間（臺北時間，週一到週五）', () => {
  it('同一個工作日內，等於實際經過的時間', () => {
    expect(businessMsBetween(taipei('2026-11-10T09:00:00'), taipei('2026-11-10T15:00:00'))).toBe(6 * HOUR);
  });

  it('跨兩個工作日，等於實際經過的時間', () => {
    expect(businessMsBetween(taipei('2026-11-10T10:00:00'), taipei('2026-11-11T10:00:00'))).toBe(24 * HOUR);
  });

  it('週五 18:00 到下週一 06:00：週末不計，只算週五 6 小時加週一 6 小時', () => {
    expect(businessMsBetween(taipei('2026-11-13T18:00:00'), taipei('2026-11-16T06:00:00'))).toBe(12 * HOUR);
  });

  it('整個區間在週末，回 0', () => {
    expect(businessMsBetween(taipei('2026-11-14T08:00:00'), taipei('2026-11-15T20:00:00'))).toBe(0);
  });

  it('end 不晚於 start，回 0', () => {
    expect(businessMsBetween(taipei('2026-11-10T10:00:00'), taipei('2026-11-10T10:00:00'))).toBe(0);
    expect(businessMsBetween(taipei('2026-11-11T10:00:00'), taipei('2026-11-10T10:00:00'))).toBe(0);
  });

  it('以臺北時間分日：UTC 週日 17:00 已是臺北週一 01:00', () => {
    expect(businessMsBetween(new Date('2026-11-15T17:00:00Z'), new Date('2026-11-15T19:00:00Z'))).toBe(2 * HOUR);
  });

  it('一週涵蓋 5 個工作日', () => {
    expect(businessMsBetween(taipei('2026-11-09T00:00:00'), taipei('2026-11-16T00:00:00'))).toBe(5 * 24 * HOUR);
  });
});

describe('超過 1 個工作日', () => {
  const created = taipei('2026-11-10T10:00:00');

  it('剛好 24 小時不算逾時', () => {
    expect(isReviewOverdue(created, taipei('2026-11-11T10:00:00'))).toBe(false);
  });

  it('超過 24 小時算逾時', () => {
    expect(isReviewOverdue(created, taipei('2026-11-11T10:00:01'))).toBe(true);
  });

  it('週五 10:00 送出，到週六與週日都不逾時', () => {
    const friday = taipei('2026-11-13T10:00:00');
    expect(isReviewOverdue(friday, taipei('2026-11-14T23:00:00'))).toBe(false);
    expect(isReviewOverdue(friday, taipei('2026-11-15T23:00:00'))).toBe(false);
  });

  it('週五 10:00 送出，下週一 10:01 逾時（週五 14 小時加週一 10 小時零 1 分）', () => {
    const friday = taipei('2026-11-13T10:00:00');
    expect(isReviewOverdue(friday, taipei('2026-11-16T09:59:00'))).toBe(false);
    expect(isReviewOverdue(friday, taipei('2026-11-16T10:01:00'))).toBe(true);
  });
});
