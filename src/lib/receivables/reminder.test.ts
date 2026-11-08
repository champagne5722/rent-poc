import { describe, expect, it } from 'vitest';
import { handoverDelayLabel, shouldConfirmReminder } from './reminder';

describe('shouldConfirmReminder（24 小時內再按要確認）', () => {
  const LAST = '2026-03-10T10:00:00+08:00';

  it.each([
    ['從沒提醒過', null, '2026-03-10T10:00:00+08:00', false],
    ['同一時刻', LAST, '2026-03-10T10:00:00+08:00', true],
    ['1 分鐘後', LAST, '2026-03-10T10:01:00+08:00', true],
    ['23 小時 59 分 59 秒後', LAST, '2026-03-11T09:59:59+08:00', true],
    ['剛好 24 小時後', LAST, '2026-03-11T10:00:00+08:00', false],
    ['24 小時 1 秒後', LAST, '2026-03-11T10:00:01+08:00', false],
    ['三天後', LAST, '2026-03-13T10:00:00+08:00', false],
  ])('%s → %s', (_name, last, now, expected) => {
    expect(shouldConfirmReminder(last, now)).toBe(expected);
  });

  it('不同時區寫法表示同一個時間點，結果相同', () => {
    expect(shouldConfirmReminder('2026-03-10T02:00:00Z', '2026-03-11T09:59:59+08:00')).toBe(true);
    expect(shouldConfirmReminder('2026-03-10T02:00:00Z', '2026-03-11T10:00:00+08:00')).toBe(false);
  });

  it('上次提醒時間晚於現在（時鐘不同步）仍要求確認', () => {
    expect(shouldConfirmReminder('2026-03-10T10:00:05+08:00', LAST)).toBe(true);
  });

  it('跨日但不滿 24 小時仍要求確認', () => {
    expect(shouldConfirmReminder('2026-03-10T23:30:00+08:00', '2026-03-11T08:00:00+08:00')).toBe(true);
  });

  it('時間格式錯誤時丟 RangeError', () => {
    expect(() => shouldConfirmReminder('昨天', LAST)).toThrow(RangeError);
    expect(() => shouldConfirmReminder(LAST, 'now')).toThrow(RangeError);
  });
});

describe('handoverDelayLabel（代收交付逾期標示）', () => {
  // 入帳日 2026-03-02。交付日 03-07 是第 5 日，03-08 是第 6 日。
  const RECEIVED = '2026-03-02';

  describe('一般案件：只看約定日數', () => {
    it.each([
      ['沒有約定日數', null, '2026-03-30', null],
      ['約定 7 日，第 7 日交付', 7, '2026-03-09', null],
      ['約定 7 日，第 8 日交付', 7, '2026-03-10', { key: 'over_agreed_days', agreedDays: 7, elapsedDays: 8 }],
      ['約定 7 日，當天交付', 7, '2026-03-02', null],
      ['約定 0 日，當天交付', 0, '2026-03-02', null],
      ['約定 0 日，次日交付', 0, '2026-03-03', { key: 'over_agreed_days', agreedDays: 0, elapsedDays: 1 }],
      ['約定 3 日，第 6 日交付：一般案件不套 5 日', 3, '2026-03-08', { key: 'over_agreed_days', agreedDays: 3, elapsedDays: 6 }],
    ])('%s', (_name, agreed, handedOver, expected) => {
      expect(handoverDelayLabel(agreed, handedOver, RECEIVED, false)).toEqual(expected);
    });

    it('一般案件超過 5 日但沒超過約定日數：不標示', () => {
      expect(handoverDelayLabel(10, '2026-03-10', RECEIVED, false)).toBeNull();
    });
  });

  describe('社宅代管案件：5 日優先', () => {
    it.each([
      ['第 5 日交付', null, '2026-03-07', null],
      ['第 6 日交付', null, '2026-03-08', { key: 'over_social_housing_5_days', limitDays: 5, elapsedDays: 6 }],
      ['約定 10 日，第 6 日交付：5 日仍適用', 10, '2026-03-08', { key: 'over_social_housing_5_days', limitDays: 5, elapsedDays: 6 }],
      ['約定 3 日，第 6 日交付：兩者都逾期，5 日優先', 3, '2026-03-08', { key: 'over_social_housing_5_days', limitDays: 5, elapsedDays: 6 }],
      ['約定 3 日，第 4 日交付：未逾 5 日，標示逾約定', 3, '2026-03-06', { key: 'over_agreed_days', agreedDays: 3, elapsedDays: 4 }],
      ['約定 3 日，第 3 日交付', 3, '2026-03-05', null],
    ])('%s', (_name, agreed, handedOver, expected) => {
      expect(handoverDelayLabel(agreed, handedOver, RECEIVED, true)).toEqual(expected);
    });
  });

  describe('尚未交付：以 today 計算', () => {
    it('有 today：算到今天', () => {
      expect(handoverDelayLabel(7, null, RECEIVED, false, '2026-03-10')).toEqual({
        key: 'over_agreed_days',
        agreedDays: 7,
        elapsedDays: 8,
      });
      expect(handoverDelayLabel(7, null, RECEIVED, false, '2026-03-09')).toBeNull();
    });
    it('社宅案件尚未交付，第 6 日起標示逾 5 日', () => {
      expect(handoverDelayLabel(null, null, RECEIVED, true, '2026-03-07')).toBeNull();
      expect(handoverDelayLabel(null, null, RECEIVED, true, '2026-03-08')).toMatchObject({
        key: 'over_social_housing_5_days',
      });
    });
    it('沒有 today 又未交付：回傳 null', () => {
      expect(handoverDelayLabel(0, null, RECEIVED, true)).toBeNull();
    });
    it('已交付時忽略 today', () => {
      expect(handoverDelayLabel(7, '2026-03-05', RECEIVED, false, '2026-12-31')).toBeNull();
    });
  });

  it('跨月與閏年照日曆日算', () => {
    // 2028-02-27 入帳，2028-03-04 交付：2/28、2/29、3/1、3/2、3/3、3/4 共 6 日
    expect(handoverDelayLabel(null, '2028-03-04', '2028-02-27', true)).toMatchObject({ elapsedDays: 6 });
    // 平年同樣的日期只有 5 日，剛好不逾期
    expect(handoverDelayLabel(null, '2027-03-04', '2027-02-27', true)).toBeNull();
  });

  describe('不合法的輸入丟 RangeError', () => {
    it('交付日早於入帳日', () => {
      expect(() => handoverDelayLabel(7, '2026-03-01', RECEIVED, false)).toThrow(RangeError);
    });
    it('約定日數不是 0 以上整數', () => {
      expect(() => handoverDelayLabel(-1, '2026-03-03', RECEIVED, false)).toThrow(RangeError);
      expect(() => handoverDelayLabel(2.5, '2026-03-03', RECEIVED, false)).toThrow(RangeError);
    });
    it('日期格式錯誤', () => {
      expect(() => handoverDelayLabel(7, '2026/03/03', RECEIVED, false)).toThrow(RangeError);
    });
  });
});
