import { describe, expect, it } from 'vitest';
import { DEPOSIT_LIMIT_MONTHS, depositWarning } from './deposit-warning';

describe('depositWarning（P0-10 規則 7，只警告不阻擋）', () => {
  it('上限是 2 個月租金', () => {
    expect(DEPOSIT_LIMIT_MONTHS).toBe(2);
  });

  it('剛好 2 個月租金不警告', () => {
    expect(depositWarning(28000, 56000)).toBeNull();
  });

  it('超過 2 個月租金一元就警告，並帶出上限金額', () => {
    const warning = depositWarning(28000, 56001);
    expect(warning).not.toBeNull();
    expect(warning?.limit).toBe(56000);
    expect(warning?.deposit).toBe(56001);
    expect(warning?.rent).toBe(28000);
  });

  it('未滿 2 個月租金不警告', () => {
    expect(depositWarning(28000, 28000)).toBeNull();
    expect(depositWarning(28000, 0)).toBeNull();
  });

  it('租金未填不警告', () => {
    expect(depositWarning(null, 100000)).toBeNull();
    expect(depositWarning(undefined, 100000)).toBeNull();
  });

  it('押金未填不警告', () => {
    expect(depositWarning(28000, null)).toBeNull();
    expect(depositWarning(28000, undefined)).toBeNull();
  });

  it('租金為 0 時無法換算月數，不警告', () => {
    expect(depositWarning(0, 1000)).toBeNull();
  });

  it('不是有限數字不警告', () => {
    expect(depositWarning(Number.NaN, 1000)).toBeNull();
    expect(depositWarning(28000, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('有小數的租金也照 2 倍比較', () => {
    expect(depositWarning(12500.5, 25001)).toBeNull();
    expect(depositWarning(12500.5, 25001.5)).not.toBeNull();
  });

  it('警告文字帶出金額與 2 個月上限，不含合法、違法字樣，也不用房東、租客', () => {
    const text = depositWarning(28000, 100000)?.message ?? '';
    expect(text).toContain('押金 $100,000');
    expect(text).toContain('2 個月');
    expect(text).toContain('$56,000');
    expect(text).not.toMatch(/違法|合法|房東|租客/);
  });
});
